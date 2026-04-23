import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { authenticateBearerOrApiKey } from "../lib/auth.js";

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
    const apiKey = c.req.header("x-api-key");
    if (!apiKey) {
      return next();
    }

    const auth = await authenticateBearerOrApiKey(
      c.req.header("authorization"),
      apiKey,
      c.env.SIGNING_KEY,
      c.get("storage"),
    );
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
