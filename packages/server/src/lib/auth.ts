import type { RelayAuthTokenClaims } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";

import { hashApiKey } from "./api-keys.js";
import { decodeBase64UrlJson, verifyHs256Signature } from "./jwt.js";
import { emitObserverEvent, now as observerNow } from "./events.js";
import type { AuthStorage, ApiKeyStorage } from "../storage/index.js";
import type { StoredApiKey } from "../storage/api-key-types.js";

// NOTE: This module duplicates some JWT verification logic from @relayauth/core TokenVerifier.
// This is intentional: core uses asymmetric JWKS (RS256/EdDSA) while this uses symmetric HMAC (HS256).
// TODO: Extract shared claims validation into @relayauth/core to reduce duplication.

type JwtHeader = {
  alg?: string;
  typ?: string;
};

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
  signingKey: string,
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

  const claims = await verifyToken(token, signingKey);
  if (!claims) {
    return { ok: false, error: "Invalid access token", code: "invalid_token", status: 401 };
  }

  return { ok: true, claims };
}

export async function authenticateBearerOrApiKey(
  request: Request,
  signingKey: string,
  storage: ApiKeyStorage | AuthStorage,
): Promise<AuthenticateSuccess | AuthenticateFailure>;
export async function authenticateBearerOrApiKey(
  authorization: string | undefined,
  apiKey: string | undefined,
  signingKey: string,
  storage: ApiKeyStorage | AuthStorage,
): Promise<AuthenticateSuccess | AuthenticateFailure>;
export async function authenticateBearerOrApiKey(
  requestOrAuthorization: Request | string | undefined,
  apiKeyOrSigningKey: string | undefined,
  signingKeyOrStorage: string | ApiKeyStorage | AuthStorage,
  maybeStorage?: ApiKeyStorage | AuthStorage,
): Promise<AuthenticateSuccess | AuthenticateFailure> {
  const { authorization, apiKey, signingKey, storage } = resolveBearerOrApiKeyArgs(
    requestOrAuthorization,
    apiKeyOrSigningKey,
    signingKeyOrStorage,
    maybeStorage,
  );
  const apiKeyStorage = resolveApiKeyStorage(storage);
  const bearerAuth = authorization
    ? await authenticate(authorization, signingKey)
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
  signingKey: string,
  requiredScope: string,
  matchScopeFn: (required: string, granted: string[]) => boolean,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code: string; status: 401 | 403 }
> {
  const auth = await authenticate(authorization, signingKey);
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

async function verifyToken(token: string, signingKey: string): Promise<RelayAuthTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    emitTokenInvalid("malformed_token");
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !payload || header.alg !== "HS256") {
    emitTokenInvalid("invalid_header", payload);
    return null;
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    emitTokenInvalid("invalid_signature", payload);
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    emitTokenInvalid("token_expired", payload);
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
    emitTokenInvalid("invalid_claims", payload);
    return null;
  }

  emitTokenVerified(payload, now);
  return payload;
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
  apiKeyOrSigningKey: string | undefined,
  signingKeyOrStorage: string | ApiKeyStorage | AuthStorage,
  maybeStorage?: ApiKeyStorage | AuthStorage,
): {
  authorization: string | undefined;
  apiKey: string | undefined;
  signingKey: string;
  storage: ApiKeyStorage | AuthStorage;
} {
  if (requestOrAuthorization instanceof Request) {
    return {
      authorization: requestOrAuthorization.headers.get("authorization") ?? undefined,
      apiKey: requestOrAuthorization.headers.get("x-api-key") ?? undefined,
      signingKey: apiKeyOrSigningKey ?? "",
      storage: signingKeyOrStorage as ApiKeyStorage | AuthStorage,
    };
  }

  return {
    authorization: requestOrAuthorization,
    apiKey: apiKeyOrSigningKey,
    signingKey: signingKeyOrStorage as string,
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
