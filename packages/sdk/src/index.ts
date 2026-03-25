export { RelayAuthClient } from "./client.js";
export type { RelayAuthClientOptions } from "./client.js";
export { TokenVerifier } from "./verify.js";
export type { VerifyOptions } from "./verify.js";
export { ScopeChecker } from "./scopes.js";
export {
  isSubsetOf,
  parseScope,
  parseScopes,
  validateScope,
} from "./scope-parser.js";
export {
  RelayAuthError,
  TokenExpiredError,
  TokenRevokedError,
  InsufficientScopeError,
  InvalidScopeError,
  IdentityNotFoundError,
  IdentitySuspendedError,
} from "./errors.js";
