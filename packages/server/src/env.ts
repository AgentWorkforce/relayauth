import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { DeferredTaskScheduler } from "./lib/deferred.js";
import type { RequestRateLimiter } from "./lib/rate-limit.js";
import type { AuthStorage } from "./storage/index.js";
import type { SponsorOidcService } from "./lib/sponsor-binding.js";

export type AppConfig = {
  INTERNAL_SECRET: string;
  BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  RELAYAUTH_SIGNING_KEY_PEM?: string;
  RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?: string;
  RELAYAUTH_ENV_STAGE?: string;
  /** JSON object keyed by org id. See SponsorFederationConfig. */
  RELAYAUTH_SPONSOR_FEDERATIONS?: string;
};

export type AppEnv = {
  Bindings: AppConfig;
  Variables: {
    requestId: string;
    storage: AuthStorage;
    deferTask: DeferredTaskScheduler;
    identityCreatePreAuthRateLimiter: RequestRateLimiter;
    identityCreateRateLimiter: RequestRateLimiter;
    sponsorOidcService: SponsorOidcService;
    // Populated by apiKeyAuth() middleware when an x-api-key successfully
    // authenticates. Downstream auth helpers read this BEFORE falling back
    // to parsing the Authorization header. We use context instead of
    // rewriting `c.req.raw.headers.set("authorization", ...)` because
    // Cloudflare Workers' Request.headers are immutable and throw
    // "Can't modify immutable headers" on mutation.
    apiKeyClaims?: RelayAuthTokenClaims;
    apiKeyVia?: "api_key";
    identityCreateRateLimitChecked?: boolean;
  };
};
