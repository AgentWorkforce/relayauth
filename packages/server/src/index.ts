export { createApp, startServer } from "./server.js";
export * from "./engine/index.js";
export * from "./middleware/scope.js";
// Storage adapters translate their provider's capacity wording into these so
// routes answer with the typed envelope instead of an unhandled 500.
export {
  isStorageCapacityExhausted,
  isStorageCapacityExhaustedError,
  StorageCapacityExhaustedError,
  STORAGE_CAPACITY_RETRY_AFTER_SECONDS,
  toStorageCapacityExhaustedError,
} from "./lib/storage-retry.js";
export {
  resolveAuthStorage,
  resolveAuditStorage,
  resolveContextStorage,
  resolvePolicyStorage,
  resolveRoleStorage,
} from "./storage/index.js";
export type {
  AuthStorage,
  AuditStorage,
  AuditWebhookStorage,
  ContextStorage,
  IdentityStorage,
  PolicyStorage,
  RevocationStorage,
  RoleStorage,
  TokenStorage,
} from "./storage/index.js";
export type { AppConfig, AppEnv } from "./env.js";
export type {
  SponsorFederationConfig,
  SponsorFederationMap,
} from "./lib/sponsor-binding.js";
// Operator step for the platform bootstrap key, and the allowlist of the
// dedicated keys that key may create via POST /v1/platform/dedicated-api-keys.
export {
  DEDICATED_API_KEY_TYPES,
  ensurePlatformBootstrapApiKey,
  isPlatformScope,
  PLATFORM_BOOTSTRAP_API_KEY_NAME,
  PLATFORM_BOOTSTRAP_SCOPE,
} from "./lib/platform-api-keys.js";
export type {
  DedicatedApiKeyType,
  EnsureExactScopeApiKeyResult,
} from "./lib/platform-api-keys.js";
export { SESSION_DIRECTORY_SEARCH_MINT_SCOPE } from "./lib/session-directory-issuer.js";
