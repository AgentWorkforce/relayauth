import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { hashApiKey, WORKSPACE_TOKEN_PREFIX } from "../lib/api-keys.js";
import { authenticateBearerOrApiKey } from "../lib/auth.js";
import {
  isRateLimitExceededError,
  RateLimitExceededError,
  type RateLimitDecision,
} from "../lib/rate-limit.js";
import { isStorageOverloadedError, storageOverloadResponse } from "../lib/storage-retry.js";

/**
 * Middleware that authenticates an x-api-key header (if present) and stores
 * the resulting claims on Hono's context. Downstream helpers in
 * `../lib/auth.ts` (authenticateFromContext, authenticateAndAuthorizeFromContext)
 * consult `c.get("apiKeyClaims")` BEFORE parsing the Authorization header, so
 * routes behind this middleware transparently accept either credential.
 *
 * IMPORTANT: this middleware MUST NOT mutate `c.req.raw.headers`. In
 * Cloudflare Workers, `Request.headers` is immutable, and any call to
 * `.set()` on it throws `TypeError: Can't modify immutable headers`.
 * That's the bug this implementation was written to fix; if you reintroduce
 * header mutation the regression test in `__tests__/api-key-auth.test.ts`
 * will fail.
 */
export function apiKeyAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("apiKeyVia") === "api_key") {
      return next();
    }

    const authorization = c.req.header("authorization");
    const apiKey = c.req.header("x-api-key") ?? extractBearerWorkspaceToken(authorization);
    if (!apiKey) {
      return next();
    }

    let auth: Awaited<ReturnType<typeof authenticateBearerOrApiKey>>;
    try {
      auth = await authenticateBearerOrApiKey(
        authorization,
        apiKey,
        c.env,
        c.get("storage"),
        {
          deferTask: c.get("deferTask"),
          beforeApiKeyLookup: (normalizedApiKey) => {
            const normalizedPath = c.req.path.replace(/\/+$/, "") || "/";
            if (
              c.req.method !== "POST"
              || normalizedPath !== "/v1/identities"
              || c.get("identityCreateRateLimitChecked")
            ) {
              return;
            }

            c.set("identityCreateRateLimitChecked", true);
            const decision = c.get("identityCreateRateLimiter").consume([
              `api-key-hash:${hashApiKey(normalizedApiKey)}`,
            ]);
            setRateLimitHeaders(c, decision);
            if (!decision.allowed) {
              throw new RateLimitExceededError(decision);
            }
          },
        },
      );
    } catch (error) {
      if (isRateLimitExceededError(error)) {
        c.header("Retry-After", String(error.decision.retryAfterSeconds));
        return c.json({
          error: "Identity create rate limit exceeded",
          code: "rate_limited",
          retryable: true,
        }, 429);
      }
      if (isStorageOverloadedError(error)) {
        return storageOverloadResponse(c, error);
      }
      throw error;
    }
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }

    if (auth.via === "api_key") {
      c.set("apiKeyClaims", auth.claims);
      c.set("apiKeyVia", "api_key");
    }

    await next();
  };
}

function setRateLimitHeaders(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  decision: RateLimitDecision,
): void {
  c.header("RateLimit-Limit", String(decision.limit));
  c.header("RateLimit-Remaining", String(decision.remaining));
  c.header("RateLimit-Reset", String(decision.retryAfterSeconds));
}

function extractBearerWorkspaceToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token || !token.startsWith(WORKSPACE_TOKEN_PREFIX)) {
    return undefined;
  }

  return token;
}
