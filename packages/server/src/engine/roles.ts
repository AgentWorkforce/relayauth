import type { Role } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";

type RoleRow = {
  id?: string;
  name?: string;
  description?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  orgId?: string;
  org_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  builtIn?: boolean | number;
  built_in?: boolean | number;
  createdAt?: string;
  created_at?: string;
};

export type CreateRoleInput = {
  name: string;
  description: string;
  scopes: string[];
  orgId: string;
  workspaceId?: string;
  builtIn?: boolean;
};

export type UpdateRoleInput = Partial<Pick<Role, "name" | "description" | "scopes">>;

class RoleEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RoleEngineError";
  }
}

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SELECT_ROLE_COLUMNS = `
  SELECT
    id,
    name,
    description,
    scopes,
    scopes_json,
    org_id AS orgId,
    workspace_id AS workspaceId,
    built_in AS builtIn,
    created_at AS createdAt
  FROM roles
`;

export async function createRole(db: D1Database, input: CreateRoleInput): Promise<Role> {
  const orgId = normalizeRequiredString(input.orgId, "orgId is required", "invalid_role_input");
  const name = validateRoleName(input.name, input.builtIn === true);
  const description = normalizeRequiredString(
    input.description,
    "description is required",
    "invalid_role_input",
  );
  const scopes = validateRoleScopes(input.scopes);
  const workspaceId = normalizeOptionalString(input.workspaceId);
  const builtIn = input.builtIn === true;

  const duplicate = await findRoleByName(db, orgId, name);
  if (duplicate) {
    throw new RoleEngineError(`Role '${name}' already exists in this org`, "role_name_conflict", 409);
  }

  const role: Role = {
    id: createRoleId(),
    name,
    description,
    scopes,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    builtIn,
    createdAt: new Date().toISOString(),
  };

  await db
    .prepare(`
      INSERT INTO roles (
        id,
        name,
        description,
        scopes,
        scopes_json,
        org_id,
        workspace_id,
        built_in,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      role.id,
      role.name,
      role.description,
      JSON.stringify(role.scopes),
      JSON.stringify(role.scopes),
      role.orgId,
      role.workspaceId ?? null,
      role.builtIn ? 1 : 0,
      role.createdAt,
    )
    .run();

  return role;
}

export async function getRole(db: D1Database, id: string): Promise<Role | null> {
  const roleId = normalizeOptionalString(id);
  if (!roleId) {
    return null;
  }

  const row = await db
    .prepare(`
      ${SELECT_ROLE_COLUMNS}
      WHERE id = ?
      LIMIT 1
    `)
    .bind(roleId)
    .first<RoleRow>();

  return hydrateRole(row);
}

export async function listRoles(
  db: D1Database,
  orgId: string,
  workspaceId?: string,
): Promise<Role[]> {
  const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required", "invalid_role_input");
  const normalizedWorkspaceId = normalizeOptionalString(workspaceId);

  const query = normalizedWorkspaceId
    ? {
        sql: `
          ${SELECT_ROLE_COLUMNS}
          WHERE org_id = ?
            AND (workspace_id = ? OR workspace_id IS NULL)
          ORDER BY name ASC, id ASC
        `,
        params: [normalizedOrgId, normalizedWorkspaceId],
      }
    : {
        sql: `
          ${SELECT_ROLE_COLUMNS}
          WHERE org_id = ?
          ORDER BY name ASC, id ASC
        `,
        params: [normalizedOrgId],
      };

  const result = await db.prepare(query.sql).bind(...query.params).all<RoleRow>();
  return (result.results ?? [])
    .map(hydrateRole)
    .filter((role): role is Role => role !== null)
    .filter((role) =>
      role.orgId === normalizedOrgId
      && (normalizedWorkspaceId === undefined
        || role.workspaceId === undefined
        || role.workspaceId === normalizedWorkspaceId),
    );
}

export async function updateRole(
  db: D1Database,
  id: string,
  updates: UpdateRoleInput,
): Promise<Role> {
  const roleId = normalizeRequiredString(id, "roleId is required", "invalid_role_input");
  const current = await getExistingMutableRole(db, roleId);

  const nextName =
    updates.name === undefined ? current.name : validateRoleName(updates.name, current.builtIn);
  const nextDescription =
    updates.description === undefined
      ? current.description
      : normalizeRequiredString(updates.description, "description is required", "invalid_role_input");
  const nextScopes =
    updates.scopes === undefined ? current.scopes : validateRoleScopes(updates.scopes);

  if (nextName !== current.name) {
    const duplicate = await findRoleByName(db, current.orgId, nextName);
    if (duplicate && duplicate.id !== current.id) {
      throw new RoleEngineError(`Role '${nextName}' already exists in this org`, "role_name_conflict", 409);
    }
  }

  await db
    .prepare(`
      UPDATE roles
      SET name = ?, description = ?, scopes = ?, scopes_json = ?
      WHERE id = ? AND org_id = ?
    `)
    .bind(
      nextName,
      nextDescription,
      JSON.stringify(nextScopes),
      JSON.stringify(nextScopes),
      current.id,
      current.orgId,
    )
    .run();

  return {
    ...current,
    name: nextName,
    description: nextDescription,
    scopes: nextScopes,
  };
}

export async function deleteRole(db: D1Database, id: string): Promise<void> {
  const role = await getExistingMutableRole(
    db,
    normalizeRequiredString(id, "roleId is required", "invalid_role_input"),
  );

  await db
    .prepare(`
      DELETE FROM roles
      WHERE id = ? AND org_id = ?
    `)
    .bind(role.id, role.orgId)
    .run();
}

export function isRoleEngineError(error: unknown): error is RoleEngineError {
  return error instanceof RoleEngineError;
}

async function getExistingMutableRole(db: D1Database, id: string): Promise<Role> {
  const role = await getRole(db, id);
  if (!role) {
    throw new RoleEngineError("role_not_found", "role_not_found", 404);
  }

  if (role.builtIn) {
    throw new RoleEngineError("built_in_role_immutable", "built_in_role_immutable", 403);
  }

  return role;
}

async function findRoleByName(db: D1Database, orgId: string, name: string): Promise<Role | null> {
  const row = await db
    .prepare(`
      ${SELECT_ROLE_COLUMNS}
      WHERE org_id = ? AND name = ?
      LIMIT 1
    `)
    .bind(orgId, name)
    .first<RoleRow>();

  return hydrateRole(row);
}

function hydrateRole(row: RoleRow | null): Role | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const description = normalizeOptionalString(row.description);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);

  if (!id || !name || !description || !orgId || !createdAt) {
    return null;
  }

  const scopes = parseStringArrayColumn(row.scopes_json ?? row.scopes);
  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const builtIn = row.builtIn === true || row.builtIn === 1 || row.built_in === true || row.built_in === 1;

  return {
    id,
    name,
    description,
    scopes,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    builtIn,
    createdAt,
  };
}

function validateRoleName(raw: string, builtIn: boolean): string {
  const name = normalizeRequiredString(raw, "name is required", "invalid_role_input");

  if (name.length < 3 || name.length > 64) {
    throw new RoleEngineError("role name must be between 3 and 64 characters", "invalid_role_input", 400);
  }

  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new RoleEngineError("role name must be kebab-case", "invalid_role_input", 400);
  }

  if (!builtIn && name.startsWith("relayauth-")) {
    throw new RoleEngineError("role names prefixed with relayauth- are reserved", "invalid_role_input", 400);
  }

  return name;
}

function validateRoleScopes(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new RoleEngineError("scopes must be a non-empty array", "invalid_role_input", 400);
  }

  const scopes = Array.from(
    new Set(
      value
        .filter((scope): scope is string => typeof scope === "string")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  );

  if (scopes.length === 0) {
    throw new RoleEngineError("scopes must be a non-empty array", "invalid_role_input", 400);
  }

  for (const scope of scopes) {
    try {
      parseScope(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid scope";
      throw new RoleEngineError(message, "invalid_scope", 400);
    }
  }

  return scopes;
}

function normalizeRequiredString(value: unknown, message: string, code: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new RoleEngineError(message, code, 400);
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseStringArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function createRoleId(): string {
  return `role_${crypto.randomUUID().replace(/-/g, "")}`;
}
