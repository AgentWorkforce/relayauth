// Auth logic — token verification
export { TokenVerifier, type VerifyOptions } from "./token-verify.js";

// Scope processing
export { parseScope, parseScopes, validateScope } from "./scope-parser.js";
export { matchScope, matchParsedScope, matchesAny, validateSubset, isSubsetOf } from "./scope-matcher.js";
export { ScopeChecker } from "./scope-checker.js";

// File ACL
export {
  filePermissionAllows,
  resolveFilePermissions,
  parsePermissionRule,
  normalizePath,
  joinPath,
  ancestorDirectories,
  DIRECTORY_PERMISSION_MARKER,
} from "./file-acl.js";
export type { TokenClaims, ParsedPermissionRule, AclStorageAdapter } from "./file-acl.js";

// Error classes
export {
  RelayAuthError,
  TokenExpiredError,
  TokenRevokedError,
  InsufficientScopeError,
  InvalidScopeError,
  IdentityNotFoundError,
  IdentitySuspendedError,
} from "./errors.js";

// Config parsing
export { parseRelayConfig, parseRelayConfigString } from "./config.js";
export type { RelayAcl, RelayAgent, RelayConfig, RelayRole } from "./config.js";
export { seedAcl, seedAclEntries } from "./acl.js";
