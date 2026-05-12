import type { RelayAuthTokenClaims, Role } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  assignRole,
  isRoleAssignmentEngineError,
  removeRole,
} from "../engine/role-assignments.js";
import { getRole } from "../engine/roles.js";
import { authenticateFromContext, authorizeClaims } from "../lib/auth.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import type { AuthStorage } from "../storage/index.js";

type AssignRoleRequest = {
  roleId?: string;
};

const roleAssignments = new Hono<AppEnv>();

roleAssignments.post("/:id/roles", async (c) => {
  const auth = await authenticateAndAuthorize(
    c,
    ["relayauth:identity:manage:*", "relayauth:role:manage:*"],
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const identityId = normalizeOptionalString(c.req.param("id"));
  if (!identityId) {
    return c.json({ error: "identityId is required" }, 400);
  }

  const body = await parseJsonObjectBody<AssignRoleRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const roleId = normalizeOptionalString(body.roleId);
  if (!roleId) {
    return c.json({ error: "roleId is required" }, 400);
  }

  const storage = c.get("storage");
  const identity = await getStoredIdentity(storage, identityId);
  if (!identity.ok) {
    return c.json({ error: identity.error }, identity.status);
  }

  if (identity.identity.orgId !== auth.claims.org) {
    return c.json({ error: "cross_org_role_assignment_forbidden" }, 403);
  }

  if (identity.identity.roles.includes(roleId)) {
    return c.json({ error: `Role '${roleId}' is already assigned to this identity` }, 409);
  }

  try {
    await assignRole(storage, identityId, roleId, auth.claims.org);
  } catch (error) {
    return handleRoleAssignmentError(c, error);
  }

  const updated = await updateStoredIdentityRoles(storage, identityId, [
    ...identity.identity.roles,
    roleId,
  ]);
  if (!updated.ok) {
    return c.json({ error: updated.error }, updated.status);
  }

  return c.json(updated.identity, 201);
});

roleAssignments.delete("/:id/roles/:roleId", async (c) => {
  const auth = await authenticateAndAuthorize(
    c,
    ["relayauth:identity:manage:*", "relayauth:role:manage:*"],
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const identityId = normalizeOptionalString(c.req.param("id"));
  if (!identityId) {
    return c.json({ error: "identityId is required" }, 400);
  }

  const roleId = normalizeOptionalString(c.req.param("roleId"));
  if (!roleId) {
    return c.json({ error: "roleId is required" }, 400);
  }

  const storage = c.get("storage");
  const identity = await getStoredIdentity(storage, identityId);
  if (!identity.ok) {
    return c.json({ error: identity.error }, identity.status);
  }

  if (identity.identity.orgId !== auth.claims.org) {
    return c.json({ error: "cross_org_role_assignment_forbidden" }, 403);
  }

  if (!identity.identity.roles.includes(roleId)) {
    return c.json({ error: `Role '${roleId}' is not assigned to this identity` }, 404);
  }

  try {
    await removeRole(storage, identityId, roleId);
  } catch (error) {
    return handleRoleAssignmentError(c, error);
  }

  const updated = await updateStoredIdentityRoles(
    storage,
    identityId,
    identity.identity.roles.filter((assignedRoleId) => assignedRoleId !== roleId),
  );
  if (!updated.ok) {
    return c.json({ error: updated.error }, updated.status);
  }

  return c.body(null, 204);
});

roleAssignments.get("/:id/roles", async (c) => {
  const auth = await authenticateAndAuthorize(
    c,
    ["relayauth:identity:read:*", "relayauth:role:read:*"],
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const identityId = normalizeOptionalString(c.req.param("id"));
  if (!identityId) {
    return c.json({ error: "identityId is required" }, 400);
  }

  const storage = c.get("storage");
  const identity = await getStoredIdentity(storage, identityId);
  if (!identity.ok) {
    return c.json({ error: identity.error }, identity.status);
  }

  if (identity.identity.orgId !== auth.claims.org) {
    return c.json({ error: "cross_org_role_assignment_forbidden" }, 403);
  }

  const roles = await loadAssignedRoles(storage, identity.identity);
  return c.json({ data: roles }, 200);
});

export default roleAssignments;

async function authenticateAndAuthorize(
  c: Context<AppEnv>,
  requiredScopes: string[],
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code?: string; status: 401 | 403 }
> {
  const auth = await authenticateFromContext(c);
  if (!auth.ok) {
    return auth;
  }

  for (const scope of requiredScopes) {
    const allowed = authorizeClaims(auth.claims, scope, matchScope);
    if (!allowed.ok) {
      return allowed;
    }
  }

  return auth;
}

async function parseJsonObjectBody<T extends object>(request: Request): Promise<T | null> {
  try {
    const parsed = await request.clone().json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

async function getStoredIdentity(
  storage: AuthStorage,
  identityId: string,
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 }
> {
  try {
    const identity = await storage.identities.get(identityId);
    if (!identity) {
      return { ok: false, error: "identity_not_found", status: 404 };
    }

    return { ok: true, identity };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch identity";
    return { ok: false, error: message, status: 500 };
  }
}

async function updateStoredIdentityRoles(
  storage: AuthStorage,
  identityId: string,
  roles: string[],
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 }
> {
  try {
    return {
      ok: true,
      identity: await storage.identities.update(identityId, { roles }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update identity";
    return { ok: false, error: message, status: 500 };
  }
}

async function loadAssignedRoles(storage: AuthStorage, identity: StoredIdentity): Promise<Role[]> {
  const roles = await Promise.all(
    Array.from(new Set(identity.roles))
      .map(async (roleId) => getRole(storage, roleId)),
  );

  return roles
    .filter((role): role is Role => role !== null && role.orgId === identity.orgId)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function handleRoleAssignmentError(c: Context<AppEnv>, error: unknown): Response {
  if (isRoleAssignmentEngineError(error)) {
    return c.json({ error: error.code }, error.status as 400 | 403 | 404 | 409);
  }

  const message = error instanceof Error ? error.message : "internal_error";
  return c.json({ error: message || "internal_error" }, 500);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
