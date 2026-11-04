import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { authenticateFromContext, authorizeClaims } from "../lib/auth.js";
import { matchBrokerScopeExactly } from "../lib/broker-scopes.js";
import {
  dedicatedKeyAuditEntry,
  ensureExactScopeApiKey,
  PLATFORM_BOOTSTRAP_SCOPE,
  resolveDedicatedApiKeyType,
} from "../lib/platform-api-keys.js";
import { isStorageError } from "../storage/index.js";
import type { StoredApiKey } from "../storage/api-key-types.js";

const AUDIT_RESOURCE = "platform-dedicated-api-key";

const platform = new Hono<AppEnv>();

/**
 * POST /v1/platform/dedicated-api-keys  { "type": "<dedicated key type>" }
 *
 * Creates the named dedicated key in the caller's org, carrying exactly the one
 * scope that type allows. Idempotent: when an active key with exactly that
 * scope already exists, nothing is written and no plaintext is returned.
 *
 * Callable only with the operator-provisioned platform key: a plain API key
 * whose single scope is PLATFORM_BOOTSTRAP_SCOPE. Wildcard and `manage` grants,
 * bearer tokens, identity JWTs and workspace tokens are refused.
 */
platform.post("/dedicated-api-keys", async (c) => {
  const auth = await authenticateFromContext(c);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const storage = c.get("storage");
  const actorId = auth.claims.sub;
  // Exact literal only: `*` and `relayauth:*:manage:*` imply this scope under
  // matchScope and must not satisfy it here.
  const authorized = authorizeClaims(auth.claims, PLATFORM_BOOTSTRAP_SCOPE, matchBrokerScopeExactly);
  // A platform key is a plain API key carrying this one scope. A bearer or
  // identity JWT carrying the literal proves nothing (identity scopes are
  // assignable within an org), and a workspace token is not a plain key.
  const isPlatformKey =
    authorized.ok
    && c.get("apiKeyVia") === "api_key"
    && auth.claims.meta?.apiKeyKind === "api_key"
    && auth.claims.scopes.length === 1;
  if (!isPlatformKey) {
    const code = authorized.ok ? "platform_key_required" : "insufficient_scope";
    await writeAudit(storage, dedicatedKeyAuditEntry({
      action: "scope.denied",
      result: "denied",
      actorId,
      orgId: auth.claims.org,
      resource: AUDIT_RESOURCE,
      metadata: { reason: code },
    }));
    return c.json(
      { error: "dedicated keys can only be created with the platform bootstrap key", code },
      403,
    );
  }

  const body = await c.req.raw.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body", code: "invalid_body" }, 400);
  }
  // The request names a type and nothing else: no scopes, org or name.
  const extra = Object.keys(body).filter((field) => field !== "type");
  if (extra.length > 0) {
    return c.json(
      { error: `unexpected field ${extra[0]}; only type is accepted`, code: "invalid_body" },
      400,
    );
  }
  const keyType = resolveDedicatedApiKeyType(body.type);
  if (!keyType) {
    return c.json(
      { error: "type is not a known dedicated key type", code: "unknown_dedicated_key_type" },
      400,
    );
  }

  try {
    const result = await ensureExactScopeApiKey(storage, {
      orgId: auth.claims.org,
      scope: keyType.scope,
      name: keyType.name,
      actorId,
      resource: AUDIT_RESOURCE,
    });
    // Never log the key or its prefix: the record id is enough to find it.
    console.log(
      JSON.stringify({
        event: "relayauth.platform_dedicated_key",
        type: keyType.type,
        status: result.status,
        apiKeyId: result.apiKey.id,
        actor: actorId,
      }),
    );
    if (result.status === "exists") {
      return c.json({ status: "exists", type: keyType.type, apiKey: toResponse(result.apiKey) }, 200);
    }
    return c.json(
      { status: "created", type: keyType.type, apiKey: toResponse(result.apiKey), key: result.key },
      201,
    );
  } catch (error) {
    if (isStorageError(error)) {
      return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409);
    }
    return c.json({ error: "internal_error", code: "internal_error" }, 500);
  }
});

async function writeAudit(
  storage: AppEnv["Variables"]["storage"],
  entry: ReturnType<typeof dedicatedKeyAuditEntry>,
): Promise<void> {
  try {
    await storage.audit.write(entry);
  } catch {
    // A refused request is refused whether or not its audit row lands.
  }
}

function toResponse(apiKey: StoredApiKey) {
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

export default platform;
