export { RelayAuthClient } from "./client.js";
export type { RelayAuthClientOptions } from "./client.js";
export type {
  AgentIdentity,
  CreateIdentityInput,
  IdentityStatus,
  IdentityType,
} from "@relayauth/types";
export { TokenVerifier } from "./verify.js";
export type { VerifyOptions } from "./verify.js";
export { ScopeChecker } from "./scopes.js";
export {
  parseScope,
  parseScopes,
  validateScope,
} from "./scope-parser.js";
export {
  isSubsetOf,
  matchScope,
  matchesAny,
  validateSubset,
} from "./scope-matcher.js";
export {
  RelayAuthError,
  TokenExpiredError,
  TokenRevokedError,
  InsufficientScopeError,
  InvalidScopeError,
  IdentityNotFoundError,
  IdentitySuspendedError,
} from "./errors.js";
