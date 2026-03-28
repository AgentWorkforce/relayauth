#!/usr/bin/env bash

set -euo pipefail

has_pattern() {
  local pattern="$1"
  local file="$2"

  if command -v rg >/dev/null 2>&1; then
    rg --quiet --fixed-strings "$pattern" "$file"
    return
  fi

  grep -Fq -- "$pattern" "$file"
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if ! has_pattern "$pattern" "$file"; then
    echo "contract check failed: missing '$label' in $file"
    exit 1
  fi
}

require_method_pair() {
  local ts_method="$1"
  local py_method="$2"

  require_pattern "$TS_CLIENT_FILE" "async ${ts_method}(" "TypeScript client method ${ts_method}"
  require_pattern "$PY_CLIENT_FILE" "async def ${py_method}(" "Python client method ${py_method}"
}

warn_missing() {
  local path="$1"
  local label="$2"

  if [ ! -e "$path" ]; then
    echo "contract advisory: ${label} not yet implemented at ${path}"
  fi
}

TS_INDEX_FILE="packages/sdk/typescript/src/index.ts"
TS_CLIENT_FILE="packages/sdk/typescript/src/client.ts"
TS_ERRORS_FILE="packages/sdk/typescript/src/errors.ts"
TS_SCOPES_FILE="packages/sdk/typescript/src/scopes.ts"
TS_IDENTITY_TYPES_FILE="packages/types/src/identity.ts"
TS_AUDIT_TYPES_FILE="packages/types/src/audit.ts"
TS_RBAC_TYPES_FILE="packages/types/src/rbac.ts"
TS_SCOPE_TYPES_FILE="packages/types/src/scope.ts"
TS_TOKEN_TYPES_FILE="packages/types/src/token.ts"

PY_INIT_FILE="packages/sdk/python/relayauth/__init__.py"
PY_CLIENT_FILE="packages/sdk/python/relayauth/client.py"
PY_ERRORS_FILE="packages/sdk/python/relayauth/errors.py"
PY_SCOPES_FILE="packages/sdk/python/relayauth/scopes.py"
PY_TYPES_FILE="packages/sdk/python/relayauth/types.py"

require_pattern "$TS_INDEX_FILE" "RelayAuthClient" "ts RelayAuthClient export"
require_pattern "$TS_INDEX_FILE" "TokenVerifier" "ts TokenVerifier export"
require_pattern "$TS_INDEX_FILE" "ScopeChecker" "ts ScopeChecker export"

require_pattern "$PY_INIT_FILE" "RelayAuthClient" "python RelayAuthClient export"
require_pattern "$PY_INIT_FILE" "TokenVerifier" "python TokenVerifier export"
require_pattern "$PY_INIT_FILE" "ScopeChecker" "python ScopeChecker export"

require_pattern "$TS_ERRORS_FILE" "export class RelayAuthError" "ts RelayAuthError"
require_pattern "$TS_ERRORS_FILE" "export class TokenExpiredError" "ts TokenExpiredError"
require_pattern "$TS_ERRORS_FILE" "export class TokenRevokedError" "ts TokenRevokedError"
require_pattern "$TS_ERRORS_FILE" "export class InsufficientScopeError" "ts InsufficientScopeError"
require_pattern "$TS_ERRORS_FILE" "export class InvalidScopeError" "ts InvalidScopeError"
require_pattern "$TS_ERRORS_FILE" "export class IdentityNotFoundError" "ts IdentityNotFoundError"
require_pattern "$TS_ERRORS_FILE" "export class IdentitySuspendedError" "ts IdentitySuspendedError"

require_pattern "$PY_ERRORS_FILE" "class RelayAuthError" "python RelayAuthError"
require_pattern "$PY_ERRORS_FILE" "class TokenExpiredError" "python TokenExpiredError"
require_pattern "$PY_ERRORS_FILE" "class TokenRevokedError" "python TokenRevokedError"
require_pattern "$PY_ERRORS_FILE" "class InsufficientScopeError" "python InsufficientScopeError"
require_pattern "$PY_ERRORS_FILE" "class InvalidScopeError" "python InvalidScopeError"
require_pattern "$PY_ERRORS_FILE" "class IdentityNotFoundError" "python IdentityNotFoundError"
require_pattern "$PY_ERRORS_FILE" "class IdentitySuspendedError" "python IdentitySuspendedError"

require_method_pair "createIdentity" "create_identity"
require_method_pair "getIdentity" "get_identity"
require_method_pair "listIdentities" "list_identities"
require_method_pair "updateIdentity" "update_identity"
require_method_pair "deleteIdentity" "delete_identity"
require_method_pair "suspendIdentity" "suspend_identity"
require_method_pair "reactivateIdentity" "reactivate_identity"
require_method_pair "retireIdentity" "retire_identity"
require_method_pair "issueToken" "issue_token"
require_method_pair "refreshToken" "refresh_token"
require_method_pair "revokeToken" "revoke_token"
require_method_pair "introspectToken" "introspect_token"
require_method_pair "queryAudit" "query_audit"
require_method_pair "getIdentityActivity" "get_identity_activity"
require_method_pair "exportAudit" "export_audit"
require_method_pair "createRole" "create_role"
require_method_pair "getRole" "get_role"
require_method_pair "listRoles" "list_roles"
require_method_pair "updateRole" "update_role"
require_method_pair "deleteRole" "delete_role"
require_method_pair "assignRole" "assign_role"
require_method_pair "removeRole" "remove_role"

require_pattern "$TS_SCOPES_FILE" "export class ScopeChecker" "ts ScopeChecker class"
require_pattern "$PY_SCOPES_FILE" "class ScopeChecker" "python ScopeChecker class"
require_pattern "$PY_SCOPES_FILE" "def parse_scope" "python parse_scope"
require_pattern "$PY_SCOPES_FILE" "def parse_scopes" "python parse_scopes"
require_pattern "$PY_SCOPES_FILE" "def validate_scope" "python validate_scope"

require_pattern "$TS_IDENTITY_TYPES_FILE" "export interface AgentIdentity" "ts AgentIdentity"
require_pattern "$PY_TYPES_FILE" "class AgentIdentity" "python AgentIdentity"
require_pattern "$TS_IDENTITY_TYPES_FILE" "export interface CreateIdentityInput" "ts CreateIdentityInput"
require_pattern "$PY_TYPES_FILE" "class CreateIdentityInput" "python CreateIdentityInput"
require_pattern "$TS_IDENTITY_TYPES_FILE" "export type IdentityStatus" "ts IdentityStatus"
require_pattern "$PY_TYPES_FILE" "IdentityStatus = Literal[" "python IdentityStatus"
require_pattern "$TS_IDENTITY_TYPES_FILE" "export type IdentityType" "ts IdentityType"
require_pattern "$PY_TYPES_FILE" "IdentityType = Literal[" "python IdentityType"

require_pattern "$TS_AUDIT_TYPES_FILE" "export interface AuditEntry" "ts AuditEntry"
require_pattern "$PY_TYPES_FILE" "class AuditEntry" "python AuditEntry"
require_pattern "$TS_AUDIT_TYPES_FILE" "export interface AuditQuery" "ts AuditQuery"
require_pattern "$PY_TYPES_FILE" "class AuditQuery" "python AuditQuery"

require_pattern "$TS_RBAC_TYPES_FILE" "export interface Role" "ts Role"
require_pattern "$PY_TYPES_FILE" "class Role" "python Role"
require_pattern "$TS_RBAC_TYPES_FILE" "export interface PolicyCondition" "ts PolicyCondition"
require_pattern "$PY_TYPES_FILE" "class PolicyCondition" "python PolicyCondition"
require_pattern "$TS_RBAC_TYPES_FILE" "export interface Policy" "ts Policy"
require_pattern "$PY_TYPES_FILE" "class Policy" "python Policy"

require_pattern "$TS_SCOPE_TYPES_FILE" "export interface ParsedScope" "ts ParsedScope"
require_pattern "$PY_TYPES_FILE" "class ParsedScope" "python ParsedScope"
require_pattern "$TS_SCOPE_TYPES_FILE" "export interface ScopeTemplate" "ts ScopeTemplate"
require_pattern "$PY_TYPES_FILE" "class ScopeTemplate" "python ScopeTemplate"

require_pattern "$TS_TOKEN_TYPES_FILE" "export interface TokenBudget" "ts TokenBudget"
require_pattern "$PY_TYPES_FILE" "class TokenBudget" "python TokenBudget"
require_pattern "$TS_TOKEN_TYPES_FILE" "export interface RelayAuthTokenClaims" "ts RelayAuthTokenClaims"
require_pattern "$PY_TYPES_FILE" "RelayAuthTokenClaims = Claims" "python RelayAuthTokenClaims"
require_pattern "$TS_TOKEN_TYPES_FILE" "export interface TokenPair" "ts TokenPair"
require_pattern "$PY_TYPES_FILE" "class TokenPair" "python TokenPair"

warn_missing "packages/sdk/python/relayauth/fastapi.py" "FastAPI middleware parity"
warn_missing "packages/sdk/python/relayauth/flask.py" "Flask middleware parity"
warn_missing "packages/sdk/python/relayauth/openapi_scopes.py" "OpenAPI scope generation parity"
warn_missing "packages/sdk/python/relayauth/a2a_bridge.py" "A2A bridge parity"

echo "contract check passed"
