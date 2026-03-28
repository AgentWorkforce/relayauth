export { RelayAuthClient } from "./client.js";
export type { RelayAuthClientOptions } from "./client.js";
export type {
  AgentIdentity,
  AuditEntry,
  AuditQuery,
  CreateIdentityInput,
  IdentityStatus,
  IdentityType,
  RelayAuthTokenClaims,
  Role,
  TokenPair,
} from "@relayauth/types";
export { TokenVerifier } from "./verify.js";
export type { VerifyOptions } from "./verify.js";
export { relayAuth, requireScope } from "./middleware/hono.js";
export type { RelayAuthMiddlewareOptions } from "./middleware/hono.js";
export { relayAuthExpress, requireScopeExpress } from "./middleware/express.js";
export type { RelayAuthExpressOptions } from "./middleware/express.js";
export { ScopeChecker } from "./scopes.js";
export { generateScopes } from "./openapi-scopes.js";
export type {
  OpenAPIOperation,
  OpenAPIPathItem,
  OpenAPISpec,
  ScopeDefinition,
} from "./openapi-scopes.js";
export {
  agentCardToConfiguration,
  assertValidA2aAgentCard,
  configurationToAgentCard,
} from "./a2a-bridge.js";
export type { A2aAgentCard, A2aAgentSkill } from "./a2a-bridge.js";
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
