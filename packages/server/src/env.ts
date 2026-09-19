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
  /**
   * Identity-create ceiling, as a canonical positive integer string.
   *
   * Lets a deployment retune `POST /v1/identities` throttling without a
   * release. Bounded and clamped in server.ts — a malformed or oversized
   * value falls back to the protective default rather than disabling the
   * limiter. Defaults to 60.
   */
  RELAYAUTH_IDENTITY_CREATE_RATE_LIMIT?: string;
  /** Identity-create window in ms, as a canonical positive integer string. Defaults to 60000. */
  RELAYAUTH_IDENTITY_CREATE_RATE_WINDOW_MS?: string;
  /**
   * Revocation-check ceiling, as a canonical positive integer string.
   *
   * `/v1/tokens/revocation` is bucketed per client IP, and shared egress
   * addresses make that ceiling collapse across unrelated verifiers. The
   * endpoint fails closed, so exhausting it rejects live tokens — this binding
   * exists so the ceiling can be raised without a release. Defaults to 600.
   */
  RELAYAUTH_REVOCATION_CHECK_RATE_LIMIT?: string;
  /** Revocation-check window in ms, as a canonical positive integer string. Defaults to 60000. */
  RELAYAUTH_REVOCATION_CHECK_RATE_WINDOW_MS?: string;
  /**
   * Hard storage ceiling in bytes, as a canonical positive integer string.
   *
   * Unset leaves the capacity guardrail entirely off: nothing is graded, no
   * `relayauth.storage.capacity` line is emitted, and `/v1/stats/storage`
   * reports the observed size without a level. Set it to the backend's real
   * per-database cap so approaching that cap becomes an early signal rather
   * than a run failure.
   */
  RELAYAUTH_STORAGE_CAPACITY_BYTES?: string;
  /** Ratio of capacity at which the guardrail warns. In (0, 1]. Defaults to 0.70. */
  RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO?: string;
  /** Ratio of capacity at which the guardrail escalates. In (0, 1]. Defaults to 0.85. */
  RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO?: string;
  /**
   * Ratio at which `POST /v1/identities` sheds load with the retryable
   * storage-capacity envelope, measured net of reclaimable freelist space.
   *
   * Unset means never shed, which is the default. Setting it trades some
   * identity creates for a typed, retryable 503 instead of the hard write
   * failure that arrives when the ceiling is actually reached. Shedding also
   * requires a fresh capacity sample; without one it stays off.
   */
  RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO?: string;
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
