import type { RelayAuthTokenClaims } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";

import { decodeBase64UrlJson, verifyHs256Signature } from "./jwt.js";
import { emitObserverEvent, now as observerNow } from "./events.js";

// NOTE: This module duplicates some JWT verification logic from @relayauth/core TokenVerifier.
// This is intentional: core uses asymmetric JWKS (RS256/EdDSA) while this uses symmetric HMAC (HS256).
// TODO: Extract shared claims validation into @relayauth/core to reduce duplication.

type JwtHeader = {
  alg?: string;
  typ?: string;
};

export async function authenticate(
  authorization: string | undefined,
  signingKey: string,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code: string; status: 401 }
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

  try {
    const allowed = matchScopeFn(requiredScope, auth.claims.scopes);
    const matchedScope = allowed
      ? findMatchedScope(requiredScope, auth.claims.scopes, matchScopeFn)
      : undefined;
    emitScopeCheck(auth.claims, requiredScope, allowed ? "allowed" : "denied", matchedScope);

    if (!allowed) {
      emitScopeDenied(auth.claims, requiredScope, "insufficient_scope", matchedScope);
      return { ok: false, error: "insufficient_scope", code: "insufficient_scope", status: 403 };
    }
  } catch {
    emitScopeCheck(auth.claims, requiredScope, "denied");
    emitScopeDenied(auth.claims, requiredScope, "scope_evaluation_error");
    return { ok: false, error: "insufficient_scope", code: "insufficient_scope", status: 403 };
  }

  return auth;
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
