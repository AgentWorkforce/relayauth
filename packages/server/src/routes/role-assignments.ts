import type { RelayAuthTokenClaims, Role } from "@relayauth/types";
import { matchScope, parseScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  assignRole,
  isRoleAssignmentEngineError,
  removeRole,
} from "../engine/role-assignments.js";
import { getRole } from "../engine/roles.js";
import { emitObserverEvent, now as observerNow } from "../lib/events.js";
import { verifyRs256Token } from "../lib/token-verifier.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import type { AuthStorage } from "../storage/index.js";

type AssignRoleRequest = {
  roleId?: string;
};

const roleAssignments = new Hono<AppEnv>();

roleAssignments.post("/:id/roles", async (c) => {
  const auth = await authenticateAndAuthorize(
    c,
    c.env,
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
    c.env,
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
    c.env,
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
  env: AppEnv["Bindings"],
  requiredScopes: string[],
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; status: 401 | 403 }
> {
  const auth = await authenticate(c, env);
  if (!auth.ok) {
    return auth;
  }

  const allowed = requiredScopes.every((scope) => matchScope(scope, auth.claims.scopes));
  emitScopeChecks(auth.claims, requiredScopes, allowed);

  if (!allowed) {
    return { ok: false, error: "insufficient_scope", status: 403 };
  }

  return auth;
}

async function authenticate(
  c: Context<AppEnv>,
  env: AppEnv["Bindings"],
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; status: 401 }
> {
  // Prefer claims injected by `apiKeyAuth()` middleware on successful x-api-key
  // authentication. See ../middleware/api-key-auth.ts for why we use the
  // context instead of rewriting the Authorization header.
  const apiKeyClaims = c.get("apiKeyClaims");
  if (apiKeyClaims) {
    return { ok: true, claims: apiKeyClaims };
  }

  const authorization = c.req.header("authorization");
  if (!authorization) {
    emitTokenInvalid("missing_authorization");
    return { ok: false, error: "Missing Authorization header", status: 401 };
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    emitTokenInvalid("invalid_authorization");
    return { ok: false, error: "Invalid Authorization header", status: 401 };
  }

  const claims = await verifyToken(token, env);
  if (!claims) {
    return { ok: false, error: "Invalid access token", status: 401 };
  }

  return { ok: true, claims };
}

async function verifyToken(token: string, env: AppEnv["Bindings"]): Promise<RelayAuthTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    emitTokenInvalid("malformed_token");
    return null;
  }

  const [, encodedPayload] = parts;
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);

  try {
    const claims = await verifyRs256Token(token, env);
    emitTokenVerified(claims, Math.floor(Date.now() / 1000));
    return claims;
  } catch {
    emitTokenInvalid("invalid_token", payload);
    return null;
  }
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

function emitTokenVerified(claims: RelayAuthTokenClaims, nowSeconds: number): void {
  emitObserverEvent({
    type: "token.verified",
    timestamp: observerNow(),
    payload: {
      sub: claims.sub,
      org: claims.org,
      scopes: Array.isArray(claims.scopes) ? [...claims.scopes] : [],
      expiresIn: Math.max(0, claims.exp - nowSeconds),
    },
  });
}

function emitTokenInvalid(reason: string, claims?: Partial<RelayAuthTokenClaims> | null): void {
  const sub = typeof claims?.sub === "string" ? claims.sub : undefined;
  const org = typeof claims?.org === "string" ? claims.org : undefined;

  emitObserverEvent({
    type: "token.invalid",
    timestamp: observerNow(),
    payload: {
      reason,
      ...(sub !== undefined ? { sub } : {}),
      ...(org !== undefined ? { org } : {}),
    },
  });
}

function emitScopeChecks(
  claims: RelayAuthTokenClaims,
  requestedScopes: string[],
  aggregateAllowed: boolean,
): void {
  for (const requestedScope of requestedScopes) {
    const allowed = aggregateAllowed ? true : scopeAllowed(requestedScope, claims.scopes);
    const matchedScope = allowed ? findMatchedScope(requestedScope, claims.scopes) : undefined;
    emitScopeCheck(claims, requestedScope, allowed ? "allowed" : "denied", matchedScope);

    if (!allowed) {
      emitScopeDenied(claims, requestedScope, "insufficient_scope", matchedScope);
    }
  }
}

function emitScopeCheck(
  claims: RelayAuthTokenClaims,
  requestedScope: string,
  result: "allowed" | "denied",
  matchedScope?: string,
): void {
  emitObserverEvent({
    type: "scope.check",
    timestamp: observerNow(),
    payload: {
      agent: claims.sub,
      requestedScope,
      grantedScopes: Array.isArray(claims.scopes) ? [...claims.scopes] : [],
      result,
      ...(matchedScope !== undefined ? { matchedScope } : {}),
      evaluation: parseScopeEvaluation(requestedScope),
    },
  });
}

function emitScopeDenied(
  claims: RelayAuthTokenClaims,
  requestedScope: string,
  reason: string,
  matchedScope?: string,
): void {
  emitObserverEvent({
    type: "scope.denied",
    timestamp: observerNow(),
    payload: {
      agent: claims.sub,
      requestedScope,
      grantedScopes: Array.isArray(claims.scopes) ? [...claims.scopes] : [],
      result: "denied",
      ...(matchedScope !== undefined ? { matchedScope } : {}),
      evaluation: parseScopeEvaluation(requestedScope),
      reason,
    },
  });
}

function scopeAllowed(requestedScope: string, grantedScopes: string[]): boolean {
  try {
    return matchScope(requestedScope, grantedScopes);
  } catch {
    return false;
  }
}

function findMatchedScope(requestedScope: string, grantedScopes: string[]): string | undefined {
  if (grantedScopes.includes("*")) {
    return "*";
  }

  for (const grantedScope of grantedScopes) {
    try {
      if (matchScope(requestedScope, [grantedScope])) {
        return grantedScope;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function parseScopeEvaluation(scope: string): { plane: string; resource: string; action: string; path: string } {
  try {
    const parsed = parseScope(scope);
    return {
      plane: parsed.plane,
      resource: parsed.resource,
      action: parsed.action,
      path: parsed.path,
    };
  } catch {
    return {
      plane: "",
      resource: "",
      action: "",
      path: scope,
    };
  }
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
