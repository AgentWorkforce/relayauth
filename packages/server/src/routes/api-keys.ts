import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { extractPrefix, generateApiKey, hashApiKey } from "../lib/api-keys.js";
import { authenticateAndAuthorize } from "../lib/auth.js";
import { isStorageError } from "../storage/index.js";
import type { StoredApiKey } from "../storage/api-key-types.js";

type CreateApiKeyRequest = {
  orgId?: string;
  name?: string;
  scopes?: string[];
};

type ApiKeyResponse = {
  id: string;
  orgId: string;
  prefix: string;
  name: string;
  scopes: string[];
  createdAt: string;
  revoked: boolean;
};

const apiKeys = new Hono<AppEnv>();

apiKeys.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:api-key:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const body = await parseJsonObjectBody<CreateApiKeyRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = normalizeRequiredString(body.name);
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const requestedOrgId = normalizeOptionalString(body.orgId);
  if (requestedOrgId && requestedOrgId !== auth.claims.org) {
    return c.json({ error: "org_mismatch", code: "org_mismatch" }, 403);
  }

  const orgId = requestedOrgId ?? auth.claims.org;
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (scopes.length === 0) {
    return c.json({ error: "scopes is required" }, 400);
  }

  try {
    const key = generateApiKey();
    const apiKey = await c.get("storage").apiKeys.create({
      orgId,
      name,
      prefix: extractPrefix(key),
      keyHash: hashApiKey(key),
      scopes,
    });

    return c.json(
      {
        apiKey: toApiKeyResponse(apiKey),
        key,
      },
      201,
    );
  } catch (error) {
    return handleApiKeyError(c, error);
  }
});

apiKeys.get("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:api-key:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const limit = parseListLimit(c.req.query("limit"));
  const cursorId = normalizeOptionalString(c.req.query("cursor"));

  try {
    const rows = await c.get("storage").apiKeys.list(auth.claims.org, {
      limit: limit + 1,
      cursorId,
      includeRevoked: true,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return c.json(
      {
        data: page.map((apiKey) => toApiKeyResponse(apiKey)),
        pagination: {
          cursor: hasMore && page.length > 0 ? page[page.length - 1]?.id ?? null : null,
          hasMore,
          limit,
        },
      },
      200,
    );
  } catch (error) {
    return handleApiKeyError(c, error);
  }
});

apiKeys.post("/:apiKeyId/revoke", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:api-key:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const apiKeyId = normalizeRequiredString(c.req.param("apiKeyId"));
  if (!apiKeyId) {
    return c.json({ error: "api_key_not_found" }, 404);
  }

  try {
    const existing = await c.get("storage").apiKeys.get(apiKeyId);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "api_key_not_found" }, 404);
    }

    const revoked = await c.get("storage").apiKeys.revoke(apiKeyId, new Date().toISOString());
    return c.json(toApiKeyResponse(revoked), 200);
  } catch (error) {
    return handleApiKeyError(c, error);
  }
});

export default apiKeys;

function toApiKeyResponse(apiKey: StoredApiKey): ApiKeyResponse {
  return {
    id: apiKey.id,
    orgId: apiKey.orgId,
    prefix: apiKey.prefix,
    name: apiKey.name,
    scopes: [...apiKey.scopes],
    createdAt: apiKey.createdAt,
    revoked: Boolean(apiKey.revokedAt),
  };
}

async function parseJsonObjectBody<T>(request: Request): Promise<T | null> {
  const body = await request.json().catch(() => null) as T | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return body;
}

function parseListLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 50;
  }

  return Math.min(parsed, 100);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequiredString(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function handleApiKeyError(c: Context<AppEnv>, error: unknown): Response {
  if (isStorageError(error)) {
    return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409);
  }

  const message = error instanceof Error ? error.message : "internal_error";
  return c.json({ error: message, code: "internal_error" }, 500);
}
