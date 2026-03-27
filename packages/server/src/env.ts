import type { AuthStorage } from "./storage/index.js";

export type AppEnv = {
  Bindings: {
    SIGNING_KEY: string;
    SIGNING_KEY_ID: string;
    INTERNAL_SECRET: string;
    BASE_URL?: string;
    ALLOWED_ORIGINS?: string;
  };
  Variables: {
    requestId: string;
    storage: AuthStorage;
  };
};
