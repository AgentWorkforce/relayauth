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
import type { StoredIdentity } from "../storage/identity-types.js";
import type { AuthStorage } from "../storage/index.js";

type AssignRoleRequest = {
  roleId?: string;
};

type JwtHeader = {
  alg?: string;
  typ?: string;
};

const roleAssignments = new Hono<AppEnv>();

roleAssignments.post("/:id/roles", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
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
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
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
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
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
  authorization: string | undefined,
  signingKey: string,
  requiredScopes: string[],
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; status: 401 | 403 }
> {
  const auth = await authenticate(authorization, signingKey);
  if (!auth.ok) {
    return auth;
  }

  if (!requiredScopes.every((scope) => matchScope(scope, auth.claims.scopes))) {
    return { ok: false, error: "insufficient_scope", status: 403 };
  }

  return auth;
}

async function authenticate(
  authorization: string | undefined,
  signingKey: string,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; status: 401 }
> {
  if (!authorization) {
    return { ok: false, error: "Missing Authorization header", status: 401 };
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return { ok: false, error: "Invalid Authorization header", status: 401 };
  }

  const claims = await verifyToken(token, signingKey);
  if (!claims) {
    return { ok: false, error: "Invalid access token", status: 401 };
  }

  return { ok: true, claims };
}

async function verifyToken(token: string, signingKey: string): Promise<RelayAuthTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !payload || header.alg !== "HS256") {
    return null;
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return null;
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.org !== "string" ||
    typeof payload.wks !== "string" ||
    typeof payload.sponsorId !== "string" ||
    !Array.isArray(payload.sponsorChain)
  ) {
    return null;
  }

  return payload;
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

async function verifyHs256Signature(
  value: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64UrlToBytes(signature),
      new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

function decodeBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
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
