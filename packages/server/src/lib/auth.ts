import type { RelayAuthTokenClaims } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";
import type { Context } from "hono";

import { hashApiKey } from "./api-keys.js";
import {
  scheduleDeferredTask,
  type DeferredTaskScheduler,
} from "./deferred.js";
import { decodeBase64UrlJson, splitJwtSegments } from "./jwt.js";
import { emitObserverEvent, now as observerNow } from "./events.js";
import { withStorageRetry } from "./storage-retry.js";
import { verifyRs256Token } from "./token-verifier.js";
import type { AppEnv } from "../env.js";
import type { AuthStorage, ApiKeyStorage } from "../storage/index.js";
import type { StoredApiKey } from "../storage/api-key-types.js";

type AuthenticateFailure = {
  ok: false;
  error: string;
  code: string;
  status: 401;
};

type AuthenticateSuccess = {
  ok: true;
  claims: RelayAuthTokenClaims;
  via?: "bearer" | "api_key";
};

export type ApiKeyAuthenticationOptions = {
  deferTask?: DeferredTaskScheduler;
  now?: () => number;
  beforeApiKeyLookup?: (apiKey: string) => void;
};

export const API_KEY_LAST_USED_DEBOUNCE_MS = 5 * 60_000;

const recentlyScheduledApiKeyTouches = new Map<string, number>();
const defaultDeferredTaskScheduler: DeferredTaskScheduler = (task) => {
  void task;
};

export async function authenticate(
  authorization: string | undefined,
  env: AppEnv["Bindings"],
): Promise<
  | AuthenticateSuccess
  | AuthenticateFailure
> {
  if (!authorization) {
    emitTokenInvalid("missing_authorization");
    return { ok: false, error: "Missing Authorization header", code: "missing_authorization", status: 401 };
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    emitTokenInvalid("invalid_authorization");
    return { ok: false, error: "Invalid Authorization header", code: "invalid_authorization", status: 401 };
  }

  const claims = await verifyToken(token, env);
  if (!claims) {
    return { ok: false, error: "Invalid access token", code: "invalid_token", status: 401 };
  }

  return { ok: true, claims };
}

export async function authenticateBearerOrApiKey(
  request: Request,
  env: AppEnv["Bindings"],
  storage: ApiKeyStorage | AuthStorage,
  options?: ApiKeyAuthenticationOptions,
): Promise<AuthenticateSuccess | AuthenticateFailure>;
export async function authenticateBearerOrApiKey(
  authorization: string | undefined,
  apiKey: string | undefined,
  env: AppEnv["Bindings"],
  storage: ApiKeyStorage | AuthStorage,
  options?: ApiKeyAuthenticationOptions,
): Promise<AuthenticateSuccess | AuthenticateFailure>;
export async function authenticateBearerOrApiKey(
  requestOrAuthorization: Request | string | undefined,
  apiKeyOrEnv: string | AppEnv["Bindings"] | undefined,
  envOrStorage: AppEnv["Bindings"] | ApiKeyStorage | AuthStorage,
  maybeStorageOrOptions?: ApiKeyStorage | AuthStorage | ApiKeyAuthenticationOptions,
  maybeOptions?: ApiKeyAuthenticationOptions,
): Promise<AuthenticateSuccess | AuthenticateFailure> {
  const options = requestOrAuthorization instanceof Request
    ? (maybeStorageOrOptions as ApiKeyAuthenticationOptions | undefined)
    : maybeOptions;
  const { authorization, apiKey, env, storage } = resolveBearerOrApiKeyArgs(
    requestOrAuthorization,
    apiKeyOrEnv,
    envOrStorage,
    requestOrAuthorization instanceof Request
      ? undefined
      : maybeStorageOrOptions as ApiKeyStorage | AuthStorage | undefined,
  );
  const apiKeyStorage = resolveApiKeyStorage(storage);
  const bearerAuth = authorization
    ? await authenticate(authorization, env)
    : null;

  if (bearerAuth?.ok) {
    return { ...bearerAuth, via: "bearer" };
  }

  const normalizedApiKey = normalizeCredential(apiKey);
  if (!normalizedApiKey) {
    if (bearerAuth && !bearerAuth.ok) {
      return bearerAuth;
    }

    return {
      ok: false,
      error: "Missing Authorization header or x-api-key",
      code: "missing_authorization",
      status: 401,
    };
  }

  options?.beforeApiKeyLookup?.(normalizedApiKey);
  const keyHash = hashApiKey(normalizedApiKey);
  const storedApiKey = await withStorageRetry(
    () => apiKeyStorage.getByHash(keyHash),
    { operation: "api_keys.get_by_hash" },
  );
  if (!storedApiKey) {
    return invalidApiKeyFailure();
  }

  if (typeof storedApiKey.keyHash === "string" && !constantTimeEquals(keyHash, storedApiKey.keyHash)) {
    return invalidApiKeyFailure();
  }

  if (normalizeCredential(storedApiKey.revokedAt ?? undefined)) {
    return {
      ok: false,
      error: "API key is revoked",
      code: "invalid_api_key",
      status: 401,
    };
  }

  scheduleApiKeyLastUsedTouch(apiKeyStorage, storedApiKey, options);

  return {
    ok: true,
    via: "api_key",
    claims: createApiKeyClaims(storedApiKey),
  };
}

export async function authenticateAndAuthorize(
  authorization: string | undefined,
  env: AppEnv["Bindings"],
  requiredScope: string,
  matchScopeFn: (required: string, granted: string[]) => boolean,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code: string; status: 401 | 403 }
> {
  const auth = await authenticate(authorization, env);
  if (!auth.ok) {
    return auth;
  }

  return authorizeClaims(auth.claims, requiredScope, matchScopeFn);
}

/**
 * Context-aware variant of `authenticate`. Resolves claims from either
 * `c.get("apiKeyClaims")` (populated by the `apiKeyAuth()` middleware when
 * an x-api-key successfully authenticated) OR by parsing and verifying the
 * Authorization bearer token.
 *
 * Callers inside route handlers should prefer this over `authenticate(...)`
 * because it transparently accepts both credentials without requiring the
 * middleware to rewrite the Authorization header (which is impossible in
 * Cloudflare Workers — Request.headers is immutable).
 */
export async function authenticateFromContext(
  c: Context<AppEnv>,
): Promise<AuthenticateSuccess | AuthenticateFailure> {
  const apiKeyClaims = c.get("apiKeyClaims");
  if (apiKeyClaims) {
    return { ok: true, claims: apiKeyClaims, via: "api_key" };
  }

  const auth = await authenticate(c.req.header("authorization"), c.env);
  if (!auth.ok) {
    return auth;
  }

  const storage = c.get("storage");
  if (await isBearerTokenInactive(storage, auth.claims)) {
    emitTokenInvalid("revoked_token", auth.claims);
    return { ok: false, error: "Invalid access token", code: "invalid_token", status: 401 };
  }

  if (await isWorkspaceLineageRevoked(storage, auth.claims)) {
    emitTokenInvalid("workspace_token_revoked", auth.claims);
    return {
      ok: false,
      error: "Workspace token has been revoked",
      code: "workspace_token_revoked",
      status: 401,
    };
  }

  return auth;
}

/**
 * Context-aware variant of `authenticateAndAuthorize`. See
 * `authenticateFromContext` for rationale.
 */
export async function authenticateAndAuthorizeFromContext(
  c: Context<AppEnv>,
  requiredScope: string,
  matchScopeFn: (required: string, granted: string[]) => boolean,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code: string; status: 401 | 403 }
> {
  const auth = await authenticateFromContext(c);
  if (!auth.ok) {
    return auth;
  }

  return authorizeClaims(auth.claims, requiredScope, matchScopeFn);
}

export function authorizeClaims(
  claims: RelayAuthTokenClaims,
  requiredScope: string,
  matchScopeFn: (required: string, granted: string[]) => boolean,
): { ok: true; claims: RelayAuthTokenClaims } | { ok: false; error: string; code: string; status: 403 } {
  try {
    const allowed = matchScopeFn(requiredScope, claims.scopes);
    const matchedScope = allowed
      ? findMatchedScope(requiredScope, claims.scopes, matchScopeFn)
      : undefined;
    emitScopeCheck(claims, requiredScope, allowed ? "allowed" : "denied", matchedScope);

    if (!allowed) {
      emitScopeDenied(claims, requiredScope, "insufficient_scope", matchedScope);
      return { ok: false, error: "insufficient_scope", code: "insufficient_scope", status: 403 };
    }
  } catch {
    emitScopeCheck(claims, requiredScope, "denied");
    emitScopeDenied(claims, requiredScope, "scope_evaluation_error");
    return { ok: false, error: "insufficient_scope", code: "insufficient_scope", status: 403 };
  }

  return { ok: true, claims };
}

async function verifyToken(token: string, env: AppEnv["Bindings"]): Promise<RelayAuthTokenClaims | null> {
  const parts = splitJwtSegments(token);
  if (!parts) {
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

function emitTokenVerified(claims: RelayAuthTokenClaims, nowSeconds: number): void {
  emitObserverEvent({
    type: "token.verified",
    timestamp: observerNow(),
    payload: {
      sub: claims.sub,
      org: claims.org,
      scopes: [...claims.scopes],
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
      grantedScopes: [...claims.scopes],
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
      grantedScopes: [...claims.scopes],
      result: "denied",
      ...(matchedScope !== undefined ? { matchedScope } : {}),
      evaluation: parseScopeEvaluation(requestedScope),
      reason,
    },
  });
}

function findMatchedScope(
  requestedScope: string,
  grantedScopes: string[],
  matchScopeFn: (required: string, granted: string[]) => boolean,
): string | undefined {
  if (grantedScopes.includes("*")) {
    return "*";
  }

  for (const grantedScope of grantedScopes) {
    try {
      if (matchScopeFn(requestedScope, [grantedScope])) {
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

export { decodeBase64UrlJson } from "./jwt.js";

function resolveBearerOrApiKeyArgs(
  requestOrAuthorization: Request | string | undefined,
  apiKeyOrEnv: string | AppEnv["Bindings"] | undefined,
  envOrStorage: AppEnv["Bindings"] | ApiKeyStorage | AuthStorage,
  maybeStorage?: ApiKeyStorage | AuthStorage,
): {
  authorization: string | undefined;
  apiKey: string | undefined;
  env: AppEnv["Bindings"];
  storage: ApiKeyStorage | AuthStorage;
} {
  if (requestOrAuthorization instanceof Request) {
    return {
      authorization: requestOrAuthorization.headers.get("authorization") ?? undefined,
      apiKey: requestOrAuthorization.headers.get("x-api-key") ?? undefined,
      env: apiKeyOrEnv as AppEnv["Bindings"],
      storage: envOrStorage as ApiKeyStorage | AuthStorage,
    };
  }

  return {
    authorization: requestOrAuthorization,
    apiKey: apiKeyOrEnv as string | undefined,
    env: envOrStorage as AppEnv["Bindings"],
    storage: maybeStorage as ApiKeyStorage | AuthStorage,
  };
}

function resolveApiKeyStorage(
  storage: ApiKeyStorage | AuthStorage,
): Pick<ApiKeyStorage, "get" | "getByHash" | "touchLastUsed"> {
  return "apiKeys" in storage ? storage.apiKeys : storage;
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function invalidApiKeyFailure(): AuthenticateFailure {
  return {
    ok: false,
    error: "Invalid API key",
    code: "invalid_api_key",
    status: 401,
  };
}

function createApiKeyClaims(
  apiKey: Pick<StoredApiKey, "id" | "name" | "orgId" | "prefix" | "scopes" | "kind" | "workspaceId">,
): RelayAuthTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  const subject = `api_key:${apiKey.id}`;
  const workspaceId =
    typeof apiKey.workspaceId === "string" && apiKey.workspaceId.trim().length > 0
      ? apiKey.workspaceId.trim()
      : "api_keys";

  return {
    sub: subject,
    org: apiKey.orgId,
    wks: workspaceId,
    workspace_id: workspaceId,
    agent_name: apiKey.name,
    scopes: [...apiKey.scopes],
    sponsorId: subject,
    sponsorChain: [subject],
    token_type: "access",
    iss: "relayauth:api-key",
    aud: ["relayauth"],
    exp: now + 300,
    iat: now,
    jti: `akjti_${crypto.randomUUID().replace(/-/g, "")}`,
    meta: {
      apiKeyId: apiKey.id,
      apiKeyPrefix: apiKey.prefix,
      apiKeyKind: apiKey.kind ?? "api_key",
    },
  };
}

async function isBearerTokenInactive(storage: AuthStorage, claims: RelayAuthTokenClaims): Promise<boolean> {
  const revocations = storage.revocations as AuthStorage["revocations"] & {
    isRevoked?: (jti: string) => Promise<boolean>;
  };
  return typeof revocations.isRevoked === "function"
    ? withStorageRetry(
      () => revocations.isRevoked!(claims.jti),
      { operation: "revocations.is_token_revoked" },
    )
    : false;
}

async function isWorkspaceLineageRevoked(
  storage: AuthStorage,
  claims: RelayAuthTokenClaims,
): Promise<boolean> {
  const workspaceTokenId = normalizeCredential(claims.meta?.workspaceTokenId);
  if (!workspaceTokenId) {
    return false;
  }

  const workspaceToken = await withStorageRetry(
    () => resolveApiKeyStorage(storage).get(workspaceTokenId),
    { operation: "api_keys.get_workspace_lineage" },
  );
  if (!workspaceToken || normalizeCredential(workspaceToken.revokedAt ?? undefined)) {
    return true;
  }

  const expectedWorkspaceId = normalizeCredential(workspaceToken.workspaceId);
  return Boolean(expectedWorkspaceId && expectedWorkspaceId !== claims.wks);
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function scheduleApiKeyLastUsedTouch(
  apiKeyStorage: Pick<ApiKeyStorage, "touchLastUsed">,
  storedApiKey: StoredApiKey,
  options: ApiKeyAuthenticationOptions | undefined,
): void {
  const nowMs = options?.now?.() ?? Date.now();
  if (!shouldTouchApiKeyLastUsed(storedApiKey, nowMs)) {
    return;
  }

  const usedAt = new Date(nowMs).toISOString();
  recentlyScheduledApiKeyTouches.set(storedApiKey.id, nowMs);
  pruneApiKeyTouchCache(nowMs);

  scheduleDeferredTask(
    options?.deferTask ?? defaultDeferredTaskScheduler,
    "api_keys.touch_last_used",
    () => withStorageRetry(
      () => apiKeyStorage.touchLastUsed(storedApiKey.id, usedAt),
      { operation: "api_keys.touch_last_used" },
    ),
    ({ error }) => {
      // Keep the debounce marker even when the best-effort write fails. A
      // storage outage must not turn every authenticated request into another
      // background write storm; approximate usage can wait for the next
      // debounce window.
      console.error("Deferred API-key usage update failed", {
        apiKeyId: storedApiKey.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

function shouldTouchApiKeyLastUsed(storedApiKey: StoredApiKey, nowMs: number): boolean {
  const storedLastUsedMs = storedApiKey.lastUsedAt
    ? Date.parse(storedApiKey.lastUsedAt)
    : Number.NaN;
  const scheduledLastUsedMs = recentlyScheduledApiKeyTouches.get(storedApiKey.id);
  const lastUsedMs = Math.max(
    Number.isFinite(storedLastUsedMs) ? storedLastUsedMs : Number.NEGATIVE_INFINITY,
    scheduledLastUsedMs ?? Number.NEGATIVE_INFINITY,
  );

  return !Number.isFinite(lastUsedMs) || nowMs - lastUsedMs >= API_KEY_LAST_USED_DEBOUNCE_MS;
}

function pruneApiKeyTouchCache(nowMs: number): void {
  if (recentlyScheduledApiKeyTouches.size < 10_000) {
    return;
  }

  for (const [apiKeyId, touchedAt] of recentlyScheduledApiKeyTouches) {
    if (nowMs - touchedAt >= API_KEY_LAST_USED_DEBOUNCE_MS) {
      recentlyScheduledApiKeyTouches.delete(apiKeyId);
    }
  }

  while (recentlyScheduledApiKeyTouches.size > 10_000) {
    const oldestApiKeyId = recentlyScheduledApiKeyTouches.keys().next().value as
      | string
      | undefined;
    if (!oldestApiKeyId) {
      break;
    }
    recentlyScheduledApiKeyTouches.delete(oldestApiKeyId);
  }
}
