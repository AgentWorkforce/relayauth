import type { RelayAuthTokenClaims, Role } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk/src/scope-matcher.js";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  createRole,
  deleteRole,
  getRole,
  isRoleEngineError,
  listRoles,
  updateRole,
} from "../engine/roles.js";

type CreateRoleRequest = {
  name?: string;
  description?: string;
  scopes?: string[];
  workspaceId?: string;
};

type UpdateRoleRequest = Partial<Pick<Role, "name" | "description" | "scopes">>;

type JwtHeader = {
  alg?: string;
  typ?: string;
};

const roles = new Hono<AppEnv>();

roles.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:manage:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const body = await parseJsonObjectBody<CreateRoleRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const role = await createRole(c.env.DB, {
      name: body.name ?? "",
      description: body.description ?? "",
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      orgId: auth.claims.org,
      ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
    });

    return c.json(role, 201);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.get("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:read:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const workspaceId = normalizeOptionalString(c.req.query("workspaceId"));
  const builtIn = parseBooleanQuery(c.req.query("builtIn"));

  try {
    const data = await listRoles(c.env.DB, auth.claims.org, workspaceId);
    return c.json(
      {
        data: builtIn === undefined ? data : data.filter((role) => role.builtIn === builtIn),
      },
      200,
    );
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.get("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:read:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const role = await getRole(c.env.DB, id);
    if (!role || role.orgId !== auth.claims.org) {
      return c.json({ error: "role_not_found" }, 404);
    }

    return c.json(role, 200);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.patch("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:manage:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const body = await parseJsonObjectBody<UpdateRoleRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates = sanitizeRoleUpdate(body);
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const existing = await getRole(c.env.DB, id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "role_not_found" }, 404);
    }

    const role = await updateRole(c.env.DB, id, updates);
    return c.json(role, 200);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.delete("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:manage:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const existing = await getRole(c.env.DB, id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "role_not_found" }, 404);
    }

    await deleteRole(c.env.DB, id);
    return c.body(null, 204);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

export default roles;

async function authenticateAndAuthorize(
  authorization: string | undefined,
  signingKey: string,
  requiredScope: string,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; status: 401 | 403 }
> {
  const auth = await authenticate(authorization, signingKey);
  if (!auth.ok) {
    return auth;
  }

  if (!matchScope(requiredScope, auth.claims.scopes)) {
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
    !Array.isArray(payload.sponsorChain) ||
    !Array.isArray(payload.scopes)
  ) {
    return null;
  }

  return payload;
}

function sanitizeRoleUpdate(body: UpdateRoleRequest): UpdateRoleRequest {
  const updates: UpdateRoleRequest = {};

  if (typeof body.name === "string") {
    updates.name = body.name.trim();
  }

  if (typeof body.description === "string") {
    updates.description = body.description.trim();
  }

  if ("scopes" in body) {
    updates.scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  }

  return updates;
}

async function parseJsonObjectBody<T>(request: Request): Promise<T | null> {
  const body = await request.json<T>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return body;
}

function handleRoleError(c: Context<AppEnv>, error: unknown): Response {
  if (isRoleEngineError(error)) {
    return c.json({ error: error.message }, error.status as 400 | 403 | 404 | 409);
  }

  const message = error instanceof Error ? error.message : "internal_error";
  return c.json({ error: message }, 500);
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
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function parseBooleanQuery(value: string | undefined): boolean | undefined {
  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
