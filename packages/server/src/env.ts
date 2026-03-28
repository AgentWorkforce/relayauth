import type { AuthStorage } from "./storage/index.js";

export type AppConfig = {
  SIGNING_KEY: string;
  SIGNING_KEY_ID: string;
  INTERNAL_SECRET: string;
  BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
};

export type AppEnv = {
  Bindings: AppConfig;
  Variables: {
    requestId: string;
    storage: AuthStorage;
  };
};
