import type { Role } from "@relayauth/types";
import type { AuthStorage } from "../storage/index.js";
import { resolveAuthStorage } from "../storage/index.js";

type RoleAssignmentStorageSource = AuthStorage;

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
  storageSource: RoleAssignmentStorageSource,
  identityId: string,
  roleId: string,
  orgId: string,
): Promise<void> {
  const storage = resolveAuthStorage(storageSource);
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

  const role = await storage.roles.get(normalizedRoleId);
  if (!role || role.orgId !== normalizedOrgId) {
    throw new RoleAssignmentEngineError("role_not_found", "role_not_found", 404);
  }

  const identity = await storage.identities.get(normalizedIdentityId);
  if (identity && identity.orgId !== normalizedOrgId) {
    throw new RoleAssignmentEngineError(
      "cross_org_role_assignment_forbidden",
      "cross_org_role_assignment_forbidden",
      403,
    );
  }
}

export async function removeRole(
  _storageSource: RoleAssignmentStorageSource,
  identityId: string,
  roleId: string,
): Promise<void> {
  normalizeRequiredString(identityId, "identityId is required", "invalid_role_assignment");
  normalizeRequiredString(roleId, "roleId is required", "invalid_role_assignment");
}

export async function listIdentityRoles(
  storageSource: RoleAssignmentStorageSource,
  identityId: string,
): Promise<Role[]> {
  const storage = resolveAuthStorage(storageSource);
  const normalizedIdentityId = normalizeRequiredString(
    identityId,
    "identityId is required",
    "invalid_role_assignment",
  );
  const identity = await storage.identities.get(normalizedIdentityId);
  if (!identity || identity.roles.length === 0) {
    return [];
  }

  const roles = await storage.roles.listByIds(identity.roles);
  return roles
    .filter((role) => role.orgId === identity.orgId)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function isRoleAssignmentEngineError(error: unknown): error is RoleAssignmentEngineError {
  return error instanceof RoleAssignmentEngineError;
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
