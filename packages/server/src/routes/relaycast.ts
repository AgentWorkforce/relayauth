import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";

import type { AppEnv } from "../env.js";
import { authenticateAndAuthorizeFromContext } from "../lib/auth.js";
import {
  createCredentialTagSigner,
  decodeArWorkspaceSegment,
  isArWorkspaceId,
  isArWorkspaceSegment,
  mintArWorkspaceKey,
} from "../lib/credential-keyring.js";
import {
  createRelaycastKeyPusher,
  RELAYCAST_ADMIN_SCOPE,
  RelaycastConfigError,
  RelaycastPushError,
  resolveRelaycastConfig,
  type RelaycastConfig,
  type RelaycastWorkspaceKeyPusher,
} from "../lib/relaycast.js";
import { generateSnowflakeId } from "../lib/snowflake.js";

/**
 * Relaycast credential issuance ("model B"). RelayAuth holds the `ar_`
 * credential tag keyring and mints `ar_ws_` workspace keys; each mint is pushed
 * into relaycast's caller-minted internal contract before it is revealed here.
 * The `ar_ws_` key is returned in exactly one response and is never stored.
 *
 * Wire fields are snake_case to mirror relaycast's internal API.
 */

// Relaycast's WORKSPACE_KEY_MAX_GRACE_MS (engine tokenRotate.ts).
const RELAYCAST_MAX_GRACE_MS = 3_600_000;
const CREDENTIAL_TAGS_CACHE_CONTROL = "public, max-age=31536000, immutable";

const relaycast = new Hono<AppEnv>();

relaycast.post("/workspaces", async (c) => {
  const auth = await authorize(c);
  if (auth instanceof Response) return auth;
  const config = relaycastConfig(c);
  if (config instanceof Response) return config;

  const body = await parseJsonObjectBody(c.req.raw);
  if (!body.ok) {
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }

  const requestedRaw = body.value?.workspace_id;
  const requested = normalizeOptionalString(requestedRaw);
  if ((requestedRaw !== undefined && requested === undefined) || (requested !== undefined && !isArWorkspaceId(requested))) {
    return c.json({ error: "workspace_id must be a 64-bit snowflake", code: "invalid_request" }, 400);
  }
  const workspaceId = requested ?? generateSnowflakeId();

  return mintAndPush(c, config, workspaceId, { keyGeneration: 1 });
});

relaycast.get("/credential-tags/:workspaceId", async (c) => {
  const auth = await authorize(c);
  if (auth instanceof Response) return auth;
  const config = relaycastConfig(c);
  if (config instanceof Response) return config;

  // Relaycast's remote tagger requests the 11-char base62 workspace segment
  // (`encodeArWorkspaceId`), not the snowflake.
  const segment = c.req.param("workspaceId");
  if (!isArWorkspaceSegment(segment)) {
    return c.json({ error: "workspace id must be an 11-character base62 segment", code: "invalid_request" }, 400);
  }
  const workspaceId = decodeArWorkspaceSegment(segment);

  const tags = await createCredentialTagSigner(config.keyring).tags(workspaceId);
  // Tags are pure routing data derived from the keyring: a cached list stays
  // correct forever because keyring rotation only appends versions — a client
  // that meets a tag it does not know refetches.
  c.header("Cache-Control", CREDENTIAL_TAGS_CACHE_CONTROL);
  return c.json({ ok: true, data: { workspace_id: workspaceId, tags: [...tags] } }, 200);
});

relaycast.post("/workspaces/:id/api-key", async (c) => {
  const auth = await authorize(c);
  if (auth instanceof Response) return auth;
  const config = relaycastConfig(c);
  if (config instanceof Response) return config;

  const workspaceId = c.req.param("id");
  if (!isArWorkspaceId(workspaceId)) {
    return c.json({ error: "workspace id must be a 64-bit snowflake", code: "invalid_request" }, 400);
  }

  const body = await parseJsonObjectBody(c.req.raw);
  if (!body.ok) {
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }

  // Relaycast's generation CAS rejects anything that does not beat the stored
  // generation, so the caller tracks generations and must state the next one.
  const keyGeneration = body.value?.key_generation;
  if (!Number.isSafeInteger(keyGeneration) || keyGeneration < 1) {
    return c.json({ error: "key_generation must be a positive integer", code: "invalid_request" }, 400);
  }
  const graceMs = body.value?.grace_ms;
  if (
    graceMs !== undefined
    && (typeof graceMs !== "number" || !Number.isInteger(graceMs) || graceMs < 0 || graceMs > RELAYCAST_MAX_GRACE_MS)
  ) {
    return c.json(
      { error: `grace_ms must be an integer between 0 and ${RELAYCAST_MAX_GRACE_MS}`, code: "invalid_request" },
      400,
    );
  }

  return mintAndPush(c, config, workspaceId, {
    keyGeneration,
    ...(graceMs === undefined ? {} : { graceMs }),
  });
});

export default relaycast;

async function authorize(c: Context<AppEnv>): Promise<Response | void> {
  const auth = await authenticateAndAuthorizeFromContext(c, RELAYCAST_ADMIN_SCOPE, matchScope);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }
}

function relaycastConfig(c: Context<AppEnv>): RelaycastConfig | Response {
  try {
    const config = resolveRelaycastConfig(c.env);
    if (config) return config;
  } catch (error) {
    if (error instanceof RelaycastConfigError) {
      return c.json({ error: error.message, code: error.code }, 503);
    }
    throw error;
  }
  return c.json(
    { error: "relaycast credential issuance is not configured", code: "relaycast_not_configured" },
    503,
  );
}

function keyPusher(c: Context<AppEnv>, config: RelaycastConfig): RelaycastWorkspaceKeyPusher {
  return c.get("relaycastKeyPusher") ?? createRelaycastKeyPusher(config);
}

async function mintAndPush(
  c: Context<AppEnv>,
  config: RelaycastConfig,
  workspaceId: string,
  input: { keyGeneration: number; graceMs?: number },
): Promise<Response> {
  const signer = createCredentialTagSigner(config.keyring);
  const apiKey = await mintArWorkspaceKey(signer, workspaceId);

  let pushed: { workspaceId: string; apiKeyGeneration: number; created: boolean };
  try {
    pushed = await keyPusher(c, config).pushWorkspaceKey(workspaceId, {
      apiKey,
      keyGeneration: input.keyGeneration,
      ...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
    });
  } catch (error) {
    if (error instanceof RelaycastPushError) {
      return c.json(
        { error: error.message, code: error.code },
        error.status as 400 | 401 | 403 | 404 | 409 | 502,
      );
    }
    throw error;
  }

  // The minted key is revealed here and nowhere else; it is never persisted.
  return c.json(
    {
      workspace_id: pushed.workspaceId,
      api_key: apiKey,
      api_key_generation: pushed.apiKeyGeneration,
    },
    pushed.created ? 201 : 200,
  );
}

type JsonObjectBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false };

async function parseJsonObjectBody(request: Request): Promise<JsonObjectBody> {
  const text = await request.text();
  if (text.trim() === "") {
    return { ok: true, value: {} };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
