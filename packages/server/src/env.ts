import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { AuthStorage } from "./storage/index.js";

export type AppConfig = {
  INTERNAL_SECRET: string;
  BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  RELAYAUTH_SIGNING_KEY_PEM?: string;
  RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?: string;
  RELAYAUTH_ENV_STAGE?: string;
};

export type AppEnv = {
  Bindings: AppConfig;
  Variables: {
    requestId: string;
    storage: AuthStorage;
    // Populated by apiKeyAuth() middleware when an x-api-key successfully
    // authenticates. Downstream auth helpers read this BEFORE falling back
    // to parsing the Authorization header. We use context instead of
    // rewriting `c.req.raw.headers.set("authorization", ...)` because
    // Cloudflare Workers' Request.headers are immutable and throw
    // "Can't modify immutable headers" on mutation.
    apiKeyClaims?: RelayAuthTokenClaims;
    apiKeyVia?: "api_key";
  };
};
