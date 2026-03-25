import type { Role } from "@relayauth/types";
import { getRole } from "./roles.js";

type IdentityRoleRow = {
  roles?: string | string[];
  roles_json?: string | string[];
};

type IdentityOrgRow = {
  orgId?: string;
  org_id?: string;
};

class RoleAssignmentEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RoleAssignmentEngineError";
  }
}

export async function assignRole(
  db: D1Database,
  identityId: string,
  roleId: string,
  orgId: string,
): Promise<void> {
  const normalizedIdentityId = normalizeRequiredString(
    identityId,
    "identityId is required",
    "invalid_role_assignment",
  );
  const normalizedRoleId = normalizeRequiredString(
    roleId,
    "roleId is required",
    "invalid_role_assignment",
  );
  const normalizedOrgId = normalizeRequiredString(
    orgId,
    "orgId is required",
    "invalid_role_assignment",
  );

  const role = await getRole(db, normalizedRoleId);
  if (!role || role.orgId !== normalizedOrgId) {
    throw new RoleAssignmentEngineError("role_not_found", "role_not_found", 404);
  }

  const identityOrgId = await getIdentityOrgId(db, normalizedIdentityId);
  if (identityOrgId && identityOrgId !== normalizedOrgId) {
    throw new RoleAssignmentEngineError(
      "cross_org_role_assignment_forbidden",
      "cross_org_role_assignment_forbidden",
      403,
    );
  }
}

export async function removeRole(
  _db: D1Database,
  identityId: string,
  roleId: string,
): Promise<void> {
  normalizeRequiredString(identityId, "identityId is required", "invalid_role_assignment");
  normalizeRequiredString(roleId, "roleId is required", "invalid_role_assignment");
}

export async function listIdentityRoles(db: D1Database, identityId: string): Promise<Role[]> {
  const normalizedIdentityId = normalizeRequiredString(
    identityId,
    "identityId is required",
    "invalid_role_assignment",
  );
  const roleIds = await getIdentityRoleIds(db, normalizedIdentityId);
  if (roleIds.length === 0) {
    return [];
  }

  const roles = await Promise.all(roleIds.map((roleId) => getRole(db, roleId)));
  return roles
    .filter((role): role is Role => role !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function isRoleAssignmentEngineError(error: unknown): error is RoleAssignmentEngineError {
  return error instanceof RoleAssignmentEngineError;
}

async function getIdentityRoleIds(db: D1Database, identityId: string): Promise<string[]> {
  const row = await db
    .prepare(`
      SELECT roles, roles_json
      FROM identities
      WHERE id = ?
      LIMIT 1
    `)
    .bind(identityId)
    .first<IdentityRoleRow>();

  return Array.from(
    new Set(
      parseStringArrayColumn(row?.roles_json ?? row?.roles)
        .map((roleId) => roleId.trim())
        .filter((roleId) => roleId.length > 0),
    ),
  );
}

async function getIdentityOrgId(db: D1Database, identityId: string): Promise<string | undefined> {
  const row = await db
    .prepare(`
      SELECT org_id AS orgId
      FROM identities
      WHERE id = ?
      LIMIT 1
    `)
    .bind(identityId)
    .first<IdentityOrgRow>();

  return normalizeOptionalString(row?.orgId) ?? normalizeOptionalString(row?.org_id);
}

function normalizeRequiredString(value: unknown, message: string, code: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new RoleAssignmentEngineError(message, code, 400);
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
