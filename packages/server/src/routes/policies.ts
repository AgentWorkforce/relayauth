import type { Policy, PolicyCondition, PolicyEffect, RelayAuthTokenClaims } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk/src/scope-matcher.js";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  isPolicyEngineError,
  listPolicies,
  updatePolicy,
} from "../engine/policies.js";

type CreatePolicyRequest = {
  name?: string;
  effect?: PolicyEffect;
  scopes?: string[];
  conditions?: PolicyCondition[];
  priority?: number;
  workspaceId?: string;
};

type UpdatePolicyRequest = Partial<
  Pick<Policy, "name" | "effect" | "scopes" | "conditions" | "priority">
>;

type JwtHeader = {
  alg?: string;
  typ?: string;
};

const policies = new Hono<AppEnv>();

policies.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:policy:manage:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const body = await parseJsonObjectBody<CreatePolicyRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const policy = await createPolicy(c.env.DB, {
      name: body.name ?? "",
      effect: (body.effect ?? "") as PolicyEffect,
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      conditions: Array.isArray(body.conditions) ? body.conditions : [],
      priority: typeof body.priority === "number" ? body.priority : Number.NaN,
      orgId: auth.claims.org,
      ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
    });

    return c.json(policy, 201);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.get("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:policy:read:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const workspaceId = normalizeOptionalString(c.req.query("workspaceId"));
  const effect = normalizePolicyEffect(c.req.query("effect"));

  try {
    const data = await listPolicies(c.env.DB, auth.claims.org, workspaceId);
    return c.json(
      {
        data: effect ? data.filter((policy) => policy.effect === effect) : data,
      },
      200,
    );
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.get("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:policy:read:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const policy = await getPolicy(c.env.DB, id);
    if (!policy || policy.orgId !== auth.claims.org) {
      return c.json({ error: "policy_not_found" }, 404);
    }

    return c.json(policy, 200);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.patch("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:policy:manage:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const body = await parseJsonObjectBody<UpdatePolicyRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates = sanitizePolicyUpdate(body);
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const existing = await getPolicy(c.env.DB, id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "policy_not_found" }, 404);
    }

    const policy = await updatePolicy(c.env.DB, id, updates, existing);
    return c.json(policy, 200);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.delete("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:policy:manage:*",
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const existing = await getPolicy(c.env.DB, id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "policy_not_found" }, 404);
    }

    await deletePolicy(c.env.DB, id, existing);
    return c.body(null, 204);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

export default policies;

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

function sanitizePolicyUpdate(body: UpdatePolicyRequest): UpdatePolicyRequest {
  const updates: UpdatePolicyRequest = {};

  if (typeof body.name === "string") {
    updates.name = body.name.trim();
  }

  if (body.effect === "allow" || body.effect === "deny") {
    updates.effect = body.effect;
  }

  if ("scopes" in body) {
    updates.scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  }

  if ("conditions" in body) {
    updates.conditions = Array.isArray(body.conditions)
      ? body.conditions.filter(
          (condition): condition is PolicyCondition =>
            typeof condition === "object" && condition !== null && !Array.isArray(condition),
        )
      : [];
  }

  if ("priority" in body) {
    updates.priority = typeof body.priority === "number" ? body.priority : Number.NaN;
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

function handlePolicyError(c: Context<AppEnv>, error: unknown): Response {
  if (isPolicyEngineError(error)) {
    return c.json({ error: error.message }, error.status as 400 | 404 | 409);
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

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePolicyEffect(value: string | undefined): PolicyEffect | undefined {
  if (value === "allow" || value === "deny") {
    return value;
  }

  return undefined;
}
