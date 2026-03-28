import type { Role } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";
import type { AuthStorage, RoleStorage } from "../storage/index.js";
import { resolveRoleStorage } from "../storage/index.js";

export type CreateRoleInput = {
  name: string;
  description: string;
  scopes: string[];
  orgId: string;
  workspaceId?: string;
  builtIn?: boolean;
};

export type UpdateRoleInput = Partial<Pick<Role, "name" | "description" | "scopes">>;

type RoleStorageSource = RoleStorage | Pick<AuthStorage, "roles">;

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

export async function createRole(
  storageSource: RoleStorageSource,
  input: CreateRoleInput,
): Promise<Role> {
  const storage = resolveRoleStorage(storageSource);
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

  const duplicate = (await storage.list(orgId)).find((role) => role.name === name);
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

  await storage.create(role);
  return role;
}

export async function getRole(
  storageSource: RoleStorageSource,
  id: string,
): Promise<Role | null> {
  const roleId = normalizeOptionalString(id);
  if (!roleId) {
    return null;
  }

  return resolveRoleStorage(storageSource).get(roleId);
}

export async function listRoles(
  storageSource: RoleStorageSource,
  orgId: string,
  workspaceId?: string,
): Promise<Role[]> {
  const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required", "invalid_role_input");
  const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
  return resolveRoleStorage(storageSource).list(normalizedOrgId, normalizedWorkspaceId);
}

export async function updateRole(
  storageSource: RoleStorageSource,
  id: string,
  updates: UpdateRoleInput,
): Promise<Role> {
  const storage = resolveRoleStorage(storageSource);
  const roleId = normalizeRequiredString(id, "roleId is required", "invalid_role_input");
  const current = await getExistingMutableRole(storage, roleId);

  const nextName =
    updates.name === undefined ? current.name : validateRoleName(updates.name, current.builtIn);
  const nextDescription =
    updates.description === undefined
      ? current.description
      : normalizeRequiredString(updates.description, "description is required", "invalid_role_input");
  const nextScopes =
    updates.scopes === undefined ? current.scopes : validateRoleScopes(updates.scopes);

  if (nextName !== current.name) {
    const duplicate = (await storage.list(current.orgId))
      .find((role) => role.name === nextName && role.id !== current.id);
    if (duplicate) {
      throw new RoleEngineError(`Role '${nextName}' already exists in this org`, "role_name_conflict", 409);
    }
  }

  return storage.update(current.id, {
    name: nextName,
    description: nextDescription,
    scopes: nextScopes,
  });
}

export async function deleteRole(
  storageSource: RoleStorageSource,
  id: string,
): Promise<void> {
  const storage = resolveRoleStorage(storageSource);
  const role = await getExistingMutableRole(
    storage,
    normalizeRequiredString(id, "roleId is required", "invalid_role_input"),
  );

  await storage.delete(role.id);
}

export function isRoleEngineError(error: unknown): error is RoleEngineError {
  return error instanceof RoleEngineError;
}

async function getExistingMutableRole(storage: RoleStorage, id: string): Promise<Role> {
  const role = await storage.get(id);
  if (!role) {
    throw new RoleEngineError("role_not_found", "role_not_found", 404);
  }

  if (role.builtIn) {
    throw new RoleEngineError("built_in_role_immutable", "built_in_role_immutable", 403);
  }

  return role;
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

function createRoleId(): string {
  return `role_${crypto.randomUUID().replace(/-/g, "")}`;
}
