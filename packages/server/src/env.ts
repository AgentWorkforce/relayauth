export type AppEnv = {
  Bindings: {
    IDENTITY_DO: DurableObjectNamespace;
    DB: D1Database;
    REVOCATION_KV: KVNamespace;
    SIGNING_KEY: string;
    SIGNING_KEY_ID: string;
    INTERNAL_SECRET: string;
    BASE_URL?: string;
    ALLOWED_ORIGINS?: string;
  };
  Variables: {
    requestId: string;
  };
};
