import type { RelayAuthTokenClaims } from "@relayauth/types";
import { matchScope, parseScope, RelayAuthError, ScopeChecker } from "@relayauth/sdk";
import type { Context, MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";
import { emitObserverEvent, now as observerNow } from "../lib/events.js";
import { decodeBase64UrlJson } from "../lib/jwt.js";
import { verifyRs256Token } from "../lib/token-verifier.js";

export type ScopeMiddlewareOptions = {
  onError?: (error: Error) => Response | Promise<Response> | void | Promise<void>;
};

type ScopeMode = "all" | "any";

type ScopeContextVariables = {
  identity: RelayAuthTokenClaims;
  scopeChecker: ScopeChecker;
};

export function requireScope(
  scope: string,
  options?: ScopeMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  return createScopeMiddleware("all", [scope], options);
}

export function requireScopes(
  scopes: string[],
  options?: ScopeMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  return createScopeMiddleware("all", scopes, options);
}

export function requireAnyScope(
  scopes: string[],
  options?: ScopeMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  return createScopeMiddleware("any", scopes, options);
}

function createScopeMiddleware(
  mode: ScopeMode,
  scopes: string[],
  options?: ScopeMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      // Prefer claims injected by `apiKeyAuth()` when an x-api-key has already
      // authenticated the request. Otherwise verify the Authorization bearer
      // token. This replaces the old in-place header rewrite approach, which
      // is unsafe in Cloudflare Workers (Request.headers is immutable).
      const apiKeyClaims = c.get("apiKeyClaims");
      const claims = apiKeyClaims
        ? apiKeyClaims
        : await verifyBearerToken(
            extractBearerToken(c.req.header("Authorization")),
            c.env,
          );
      const scopeChecker = ScopeChecker.fromToken(claims);

      setScopeVariable(c, "identity", claims);
      setScopeVariable(c, "scopeChecker", scopeChecker);

      const allowed = hasRequiredScopes(scopeChecker, scopes, mode);
      emitScopeChecks(claims, scopeChecker, scopes, mode, allowed);

      if (!allowed) {
        throw insufficientScopeError(scopes, scopeChecker.grantedScopes, mode);
      }

      await next();
    } catch (error) {
      try {
        const handled = await options?.onError?.(toError(error));
        if (handled instanceof Response) {
          return handled;
        }
      } catch {
        // If onError itself throws, fall through to jsonErrorResponse
      }

      return jsonErrorResponse(error);
    }
  };
}

function extractBearerToken(authorization: string | undefined): string {
  if (!authorization) {
    emitTokenInvalid("missing_authorization");
    throw new RelayAuthError("Missing Authorization header", "missing_authorization", 401);
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    emitTokenInvalid("invalid_authorization");
    throw new RelayAuthError("Invalid Authorization header", "invalid_authorization", 401);
  }

  return token;
}

function hasRequiredScopes(
  checker: ScopeChecker,
  scopes: string[],
  mode: ScopeMode,
): boolean {
  if (scopes.length === 0) {
    return true;
  }

  return mode === "any" ? checker.checkAny(scopes) : checker.checkAll(scopes);
}

function insufficientScopeError(
  requiredScopes: string[],
  _grantedScopes: string[],
  mode: ScopeMode,
): RelayAuthError {
  const qualifier = mode === "any" ? "one of" : "all of";
  return new RelayAuthError(
    `Insufficient scope: requires ${qualifier} [${requiredScopes.join(", ")}]`,
    "insufficient_scope",
    403,
  );
}

function setScopeVariable<Key extends keyof ScopeContextVariables>(
  c: Context<AppEnv>,
  key: Key,
  value: ScopeContextVariables[Key],
): void {
  (
    c as Context<AppEnv> & {
      set: (name: Key, value: ScopeContextVariables[Key]) => void;
    }
  ).set(key, value);
}

function jsonErrorResponse(error: unknown): Response {
  const normalized = toError(error);

  if (normalized instanceof RelayAuthError) {
    return Response.json(
      {
        error: normalized.message,
        code: normalized.code,
      },
      { status: normalized.statusCode ?? 500 },
    );
  }

  // Handle errors that carry a status code or code property (e.g. scope escalation
  // errors that may not extend RelayAuthError directly).
  const statusCode = (normalized as { statusCode?: number }).statusCode;
  const code = (normalized as { code?: string }).code;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
    return Response.json(
      {
        error: normalized.message,
        code: code ?? "auth_error",
      },
      { status: statusCode },
    );
  }

  return Response.json(
    {
      error: "Internal server error",
      code: "internal_error",
    },
    { status: 500 },
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function verifyBearerToken(
  token: string,
  env: AppEnv["Bindings"],
): Promise<RelayAuthTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    emitTokenInvalid("malformed_token");
    throw new RelayAuthError("Invalid access token", "invalid_token", 401);
  }

  const [, encodedPayload] = parts;
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);

  try {
    const claims = await verifyRs256Token(token, env);
    emitTokenVerified(claims, Math.floor(Date.now() / 1000));
    return claims;
  } catch {
    emitTokenInvalid("invalid_token", payload);
    throw new RelayAuthError("Invalid access token", "invalid_token", 401);
  }
}

function emitTokenVerified(claims: RelayAuthTokenClaims, nowSeconds: number): void {
  emitObserverEvent({
    type: "token.verified",
    timestamp: observerNow(),
    payload: {
      sub: claims.sub,
      org: claims.org,
      scopes: Array.isArray(claims.scopes) ? [...claims.scopes] : [],
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

function emitScopeChecks(
  claims: RelayAuthTokenClaims,
  checker: ScopeChecker,
  requestedScopes: string[],
  mode: ScopeMode,
  aggregateAllowed: boolean,
): void {
  if (requestedScopes.length === 0) {
    return;
  }

  if (mode === "any" && aggregateAllowed) {
    const requestedScope = requestedScopes.find((scope) => scopeAllowed(checker, scope)) ?? requestedScopes[0];
    emitScopeCheck(claims, checker, requestedScope, "allowed", findMatchedScope(requestedScope, checker.grantedScopes));
    return;
  }

  for (const requestedScope of requestedScopes) {
    const allowed = aggregateAllowed && mode === "all"
      ? true
      : scopeAllowed(checker, requestedScope);
    const matchedScope = allowed ? findMatchedScope(requestedScope, checker.grantedScopes) : undefined;
    emitScopeCheck(claims, checker, requestedScope, allowed ? "allowed" : "denied", matchedScope);

    if (!allowed) {
      emitScopeDenied(claims, checker, requestedScope, "insufficient_scope", matchedScope);
    }
  }
}

function emitScopeCheck(
  claims: RelayAuthTokenClaims,
  checker: ScopeChecker,
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
      grantedScopes: [...checker.grantedScopes],
      result,
      ...(matchedScope !== undefined ? { matchedScope } : {}),
      evaluation: parseScopeEvaluation(requestedScope),
    },
  });
}

function emitScopeDenied(
  claims: RelayAuthTokenClaims,
  checker: ScopeChecker,
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
      grantedScopes: [...checker.grantedScopes],
      result: "denied",
      ...(matchedScope !== undefined ? { matchedScope } : {}),
      evaluation: parseScopeEvaluation(requestedScope),
      reason,
    },
  });
}

function scopeAllowed(checker: ScopeChecker, requestedScope: string): boolean {
  try {
    return checker.check(requestedScope);
  } catch {
    return false;
  }
}

function findMatchedScope(requestedScope: string, grantedScopes: string[]): string | undefined {
  if (grantedScopes.includes("*")) {
    return "*";
  }

  for (const grantedScope of grantedScopes) {
    try {
      if (matchScope(requestedScope, [grantedScope])) {
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
