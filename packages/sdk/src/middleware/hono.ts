import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { MiddlewareHandler } from "hono";

import { RelayAuthError } from "../errors.js";
import { ScopeChecker } from "../scopes.js";
import { TokenVerifier, type VerifyOptions } from "../verify.js";

declare module "hono" {
  interface ContextVariableMap {
    identity: RelayAuthTokenClaims;
  }
}

export interface RelayAuthMiddlewareOptions extends VerifyOptions {
  onError?: (error: Error) => Response | Promise<Response> | void | Promise<void>;
}

export function relayAuth(options?: RelayAuthMiddlewareOptions): MiddlewareHandler {
  const { onError, ...verifyOptions } = options ?? {};
  const verifier = new TokenVerifier(verifyOptions);

  return async (c, next) => {
    try {
      const token = extractBearerToken(c.req.header("Authorization"));
      const claims = await verifier.verify(token);

      c.set("identity", claims);
      await next();
    } catch (error) {
      const handled = await onError?.(toError(error));
      if (handled instanceof Response) {
        return handled;
      }

      const normalized = toError(error);
      const status =
        normalized instanceof RelayAuthError ? (normalized.statusCode ?? 401) : 401;
      return Response.json(
        {
          error:
            normalized instanceof RelayAuthError ? normalized.message : "Authentication failed",
          code:
            normalized instanceof RelayAuthError ? normalized.code : "authentication_failed",
        },
        { status },
      );
    }
  };
}

export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    try {
      const claims = c.get("identity");
      ScopeChecker.fromToken(claims).require(scope);
      await next();
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof RelayAuthError
              ? error.message
              : "Insufficient scope",
          code: "insufficient_scope",
        },
        403,
      );
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
