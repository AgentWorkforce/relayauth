import type { RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError } from "../errors.js";
import { ScopeChecker } from "../scopes.js";
import { TokenVerifier, type VerifyOptions } from "../verify.js";

declare global {
  namespace Express {
    interface Request {
      identity?: RelayAuthTokenClaims;
    }
  }
}

type ExpressLikeRequest = {
  headers?: {
    authorization?: string | string[];
  };
  identity?: RelayAuthTokenClaims;
};

type ExpressLikeResponse = {
  status: (code: number) => ExpressLikeResponse;
  json: (body: unknown) => ExpressLikeResponse;
};

type ExpressNextFunction = () => void | Promise<void>;

export interface RelayAuthExpressOptions extends VerifyOptions {
  onError?: (
    error: Error,
    req: ExpressLikeRequest,
    res: ExpressLikeResponse,
  ) => void | Promise<void>;
}

export function relayAuthExpress(
  options?: RelayAuthExpressOptions,
): (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressNextFunction,
) => Promise<void> {
  const { onError, ...verifyOptions } = options ?? {};
  const verifier = new TokenVerifier(verifyOptions);

  return async (req, res, next) => {
    try {
      const token = extractBearerToken(req.headers?.authorization);
      const claims = await verifier.verify(token);

      req.identity = claims;
      await next();
    } catch (error) {
      const normalized = toError(error);
      await onError?.(normalized, req, res);

      const status =
        normalized instanceof RelayAuthError ? (normalized.statusCode ?? 401) : 401;
      res.status(status).json({
        error:
          normalized instanceof RelayAuthError ? normalized.message : "Authentication failed",
        code:
          normalized instanceof RelayAuthError ? normalized.code : "authentication_failed",
      });
    }
  };
}

export function requireScopeExpress(
  scope: string,
): (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressNextFunction,
) => Promise<void> {
  return async (req, res, next) => {
    try {
      const claims = req.identity;
      if (!claims) {
        throw new RelayAuthError("Authentication required", "authentication_required", 401);
      }

      ScopeChecker.fromToken(claims).require(scope);
      await next();
    } catch (error) {
      const normalized = toError(error);
      res.status(403).json({
        error:
          normalized instanceof RelayAuthError ? normalized.message : "Insufficient scope",
        code: "insufficient_scope",
      });
    }
  };
}

function extractBearerToken(authorization: string | string[] | undefined): string {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;

  if (!header) {
    throw new RelayAuthError("Missing Authorization header", "missing_authorization", 401);
  }

  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    throw new RelayAuthError("Invalid Authorization header", "invalid_authorization", 401);
  }

  return token;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
