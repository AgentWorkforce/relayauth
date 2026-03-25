import type { RelayAuthTokenClaims } from "@relayauth/types";
import { RelayAuthError } from "@relayauth/sdk/src/errors.js";
import { ScopeChecker } from "@relayauth/sdk/src/scopes.js";
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

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
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
      const token = extractBearerToken(c.req.header("Authorization"));
      const claims = await verifyHs256Token(token, c.env.SIGNING_KEY);
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

async function verifyHs256Token(
  token: string,
  signingKey: string,
): Promise<RelayAuthTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new RelayAuthError("Invalid access token", "invalid_token", 401);
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !payload || header.alg !== "HS256") {
    throw new RelayAuthError("Invalid access token", "invalid_token", 401);
  }

  const isValid = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValid) {
    throw new RelayAuthError("Invalid access token", "invalid_token", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new RelayAuthError("Token expired", "token_expired", 401);
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.org !== "string" ||
    typeof payload.wks !== "string" ||
    typeof payload.sponsorId !== "string" ||
    !Array.isArray(payload.sponsorChain)
  ) {
    throw new RelayAuthError("Invalid access token", "invalid_token", 401);
  }

  return payload;
}

async function verifyHs256Signature(
  value: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64UrlToBytes(signature),
      new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(atob(padded)) as T;
  } catch {
    return null;
  }
}

function decodeBase64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}
