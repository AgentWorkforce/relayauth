import type { RelayAuthTokenClaims } from "@relayauth/types";
import { RelayAuthError } from "@relayauth/sdk/src/errors.js";
import { ScopeChecker } from "@relayauth/sdk/src/scopes.js";
import { TokenVerifier } from "@relayauth/sdk/src/verify.js";
import type { Context, MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";

export type ScopeMiddlewareOptions = {
  onError?: (error: Error) => Response | Promise<Response> | void | Promise<void>;
};

type ScopeMode = "all" | "any";

type ScopeContextVariables = {
  identity: RelayAuthTokenClaims;
  scopeChecker: ScopeChecker;
};

const verifier = new TokenVerifier();

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
      const token = extractBearerToken(c.req.header("Authorization"));
      const claims = await verifier.verify(token, c.env.SIGNING_KEY);
      const scopeChecker = ScopeChecker.fromToken(claims);

      setScopeVariable(c, "identity", claims);
      setScopeVariable(c, "scopeChecker", scopeChecker);

      if (!hasRequiredScopes(scopeChecker, scopes, mode)) {
        throw insufficientScopeError(scopes, scopeChecker.grantedScopes, mode);
      }

      await next();
    } catch (error) {
      const handled = await options?.onError?.(toError(error));
      if (handled instanceof Response) {
        return handled;
      }

      return jsonErrorResponse(error);
    }
  };
}

function extractBearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new RelayAuthError("Missing Authorization header", "missing_authorization", 401);
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
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
  grantedScopes: string[],
  mode: ScopeMode,
): RelayAuthError {
  const qualifier = mode === "any" ? "one of" : "all of";
  return new RelayAuthError(
    `Insufficient scope: requires ${qualifier} [${requiredScopes.join(", ")}], has [${grantedScopes.join(", ")}]`,
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
