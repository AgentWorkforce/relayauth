import type { RelayAuthTokenClaims } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";
import type { Context } from "hono";

import { hashApiKey } from "./api-keys.js";
import { decodeBase64UrlJson } from "./jwt.js";
import { emitObserverEvent, now as observerNow } from "./events.js";
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
): Promise<AuthenticateSuccess | AuthenticateFailure>;
export async function authenticateBearerOrApiKey(
  authorization: string | undefined,
  apiKey: string | undefined,
  env: AppEnv["Bindings"],
  storage: ApiKeyStorage | AuthStorage,
): Promise<AuthenticateSuccess | AuthenticateFailure>;
export async function authenticateBearerOrApiKey(
  requestOrAuthorization: Request | string | undefined,
  apiKeyOrEnv: string | AppEnv["Bindings"] | undefined,
  envOrStorage: AppEnv["Bindings"] | ApiKeyStorage | AuthStorage,
  maybeStorage?: ApiKeyStorage | AuthStorage,
): Promise<AuthenticateSuccess | AuthenticateFailure> {
  const { authorization, apiKey, env, storage } = resolveBearerOrApiKeyArgs(
    requestOrAuthorization,
    apiKeyOrEnv,
    envOrStorage,
    maybeStorage,
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

  const keyHash = hashApiKey(normalizedApiKey);
  const storedApiKey = await apiKeyStorage.getByHash(keyHash);
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

  await apiKeyStorage.touchLastUsed(storedApiKey.id, new Date().toISOString());

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

  return authenticate(c.req.header("authorization"), c.env);
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

function resolveApiKeyStorage(storage: ApiKeyStorage | AuthStorage): Pick<ApiKeyStorage, "getByHash" | "touchLastUsed"> {
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

function createApiKeyClaims(apiKey: Pick<StoredApiKey, "id" | "name" | "orgId" | "prefix" | "scopes">): RelayAuthTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  const subject = `api_key:${apiKey.id}`;

  return {
    sub: subject,
    org: apiKey.orgId,
    wks: "api_keys",
    workspace_id: "api_keys",
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
    },
  };
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
