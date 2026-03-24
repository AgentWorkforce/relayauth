# relayauth OpenAPI v3 Specification Design

## Meta

- **OpenAPI version**: 3.1.0
- **Base URL**: `https://api.relayauth.dev/v1`
- **Content-Type**: `application/json` (all requests and responses)
- **API versioning**: URL path prefix (`/v1`)

---

## Authentication

### Security Scheme

```yaml
securitySchemes:
  bearerAuth:
    type: http
    scheme: bearer
    bearerFormat: JWT
    description: >
      JWT issued by relayauth. Access tokens are short-lived (default 1h).
      Include in Authorization header: `Bearer <token>`.
      Tokens contain: sub, org, wks, scopes, sponsor, sponsorChain, exp.
```

All endpoints require `bearerAuth` except:
- `GET /.well-known/jwks.json` (public)
- `POST /v1/tokens` (uses org API key via `X-API-Key` header)
- `GET /v1/health` (public)

### API Key Scheme (for token issuance)

```yaml
securitySchemes:
  apiKeyAuth:
    type: apiKey
    in: header
    name: X-API-Key
    description: Organization API key used for initial token issuance.
```

---

## Common Schemas

### Error Response

All errors follow RFC 7807 Problem Details.

```yaml
ErrorResponse:
  type: object
  required: [error, code, message]
  properties:
    error:
      type: string
      description: Machine-readable error type
      example: "invalid_scope"
    code:
      type: integer
      description: HTTP status code
      example: 403
    message:
      type: string
      description: Human-readable description
      example: "Scope 'relayfile:fs:delete:*' is not granted to this identity"
    details:
      type: object
      additionalProperties: true
      description: Additional context (validation errors, conflicting fields, etc.)
    requestId:
      type: string
      description: Unique request ID for support/debugging
      example: "req_abc123"
```

**Standard error codes**: 400, 401, 403, 404, 409, 422, 429, 500

### Paginated Response

Cursor-based pagination on all list endpoints.

```yaml
PaginatedResponse:
  type: object
  required: [data, pagination]
  properties:
    data:
      type: array
      items: {}
    pagination:
      type: object
      required: [hasMore]
      properties:
        cursor:
          type: string
          nullable: true
          description: Cursor for next page, null if no more results
        hasMore:
          type: boolean
        limit:
          type: integer
          description: Page size used
          example: 50
```

**Query parameters for all list endpoints**:
- `cursor` (string, optional) — opaque pagination cursor
- `limit` (integer, optional, default: 50, max: 200)

### Timestamp Format

All timestamps are ISO 8601 strings: `2024-03-24T12:00:00Z`

---

## Endpoint Groups

### 1. Tokens (`/v1/tokens`)

#### POST /v1/tokens — Issue Token

Issue a new access/refresh token pair for an identity.

- **Auth**: `apiKeyAuth` (X-API-Key)
- **Request Body**:

```yaml
CreateTokenRequest:
  type: object
  required: [identityId]
  properties:
    identityId:
      type: string
      example: "agent_8x2k"
    scopes:
      type: array
      items: { type: string }
      description: Requested scopes (must be subset of identity's granted scopes)
    workspaceId:
      type: string
      description: Target workspace
    ttl:
      type: string
      description: Access token TTL (e.g., "1h", "30m"). Max per org config.
      default: "1h"
    audience:
      type: array
      items: { type: string }
      description: Target planes/services
```

- **Response 201**: `TokenPair`

```yaml
TokenPair:
  type: object
  required: [accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, tokenType]
  properties:
    accessToken:
      type: string
    refreshToken:
      type: string
    accessTokenExpiresAt:
      type: string
      format: date-time
    refreshTokenExpiresAt:
      type: string
      format: date-time
    tokenType:
      type: string
      enum: [Bearer]
```

#### POST /v1/tokens/refresh — Refresh Token

Exchange a refresh token for a new token pair.

- **Auth**: None (refresh token in body)
- **Request Body**:

```yaml
RefreshTokenRequest:
  type: object
  required: [refreshToken]
  properties:
    refreshToken:
      type: string
```

- **Response 200**: `TokenPair`

#### POST /v1/tokens/revoke — Revoke Token

Revoke an access token or all tokens for an identity. Global, <1s propagation.

- **Auth**: `bearerAuth`
- **Request Body**:

```yaml
RevokeTokenRequest:
  type: object
  properties:
    tokenId:
      type: string
      description: Specific token JTI to revoke
    identityId:
      type: string
      description: Revoke all tokens for this identity
    reason:
      type: string
```

At least one of `tokenId` or `identityId` is required.

- **Response 204**: No content

#### POST /v1/tokens/validate — Validate Token

Introspect and validate a token. Returns decoded claims if valid.

- **Auth**: `bearerAuth` or `apiKeyAuth`
- **Request Body**:

```yaml
ValidateTokenRequest:
  type: object
  required: [token]
  properties:
    token:
      type: string
    requiredScopes:
      type: array
      items: { type: string }
      description: Optionally check that token has these scopes
```

- **Response 200**:

```yaml
ValidateTokenResponse:
  type: object
  required: [valid, claims]
  properties:
    valid:
      type: boolean
    claims:
      $ref: "#/components/schemas/RelayAuthTokenClaims"
    missingScopes:
      type: array
      items: { type: string }
      description: Scopes from requiredScopes not present in token
```

#### GET /v1/tokens/{identityId} — List Active Tokens

List active tokens for an identity.

- **Auth**: `bearerAuth` (requires `relayauth:token:read`)
- **Path params**: `identityId` (string)
- **Query params**: pagination
- **Response 200**: `PaginatedResponse` of active token metadata (jti, scopes, exp, iat — not the raw JWT)

---

### 2. JWKS (`/.well-known/jwks.json`)

#### GET /.well-known/jwks.json — Get JSON Web Key Set

Public endpoint. Returns signing keys for offline JWT validation.

- **Auth**: None
- **Response 200**:

```yaml
JWKSResponse:
  type: object
  required: [keys]
  properties:
    keys:
      type: array
      items:
        type: object
        description: JWK per RFC 7517
```

---

### 3. Identities (`/v1/identities`)

#### POST /v1/identities — Create Identity

- **Auth**: `bearerAuth` (requires `relayauth:identity:create`)
- **Request Body**:

```yaml
CreateIdentityRequest:
  type: object
  required: [name]
  properties:
    name:
      type: string
      example: "billing-bot"
    type:
      type: string
      enum: [agent, human, service]
      default: agent
    scopes:
      type: array
      items: { type: string }
    roles:
      type: array
      items: { type: string }
      description: Role IDs to assign
    metadata:
      type: object
      additionalProperties: { type: string }
    workspaceId:
      type: string
```

- **Response 201**: `AgentIdentity`

#### GET /v1/identities — List Identities

- **Auth**: `bearerAuth` (requires `relayauth:identity:read`)
- **Query params**: `status`, `type`, `workspaceId`, pagination
- **Response 200**: `PaginatedResponse` of `AgentIdentity`

#### GET /v1/identities/{identityId} — Get Identity

- **Auth**: `bearerAuth` (requires `relayauth:identity:read`)
- **Response 200**: `AgentIdentity`

#### PATCH /v1/identities/{identityId} — Update Identity

- **Auth**: `bearerAuth` (requires `relayauth:identity:manage`)
- **Request Body**:

```yaml
UpdateIdentityRequest:
  type: object
  properties:
    name:
      type: string
    scopes:
      type: array
      items: { type: string }
    roles:
      type: array
      items: { type: string }
    metadata:
      type: object
      additionalProperties: { type: string }
```

- **Response 200**: `AgentIdentity`

#### POST /v1/identities/{identityId}/suspend — Suspend Identity

- **Auth**: `bearerAuth` (requires `relayauth:identity:manage`)
- **Request Body**:

```yaml
SuspendIdentityRequest:
  type: object
  properties:
    reason:
      type: string
      example: "Budget exceeded"
```

- **Response 200**: `AgentIdentity` (status = "suspended")

#### POST /v1/identities/{identityId}/reactivate — Reactivate Identity

- **Auth**: `bearerAuth` (requires `relayauth:identity:manage`)
- **Response 200**: `AgentIdentity` (status = "active")

#### POST /v1/identities/{identityId}/retire — Retire Identity

Permanent. Revokes all tokens. Cannot be undone.

- **Auth**: `bearerAuth` (requires `relayauth:identity:manage`)
- **Response 200**: `AgentIdentity` (status = "retired")

#### DELETE /v1/identities/{identityId} — Delete Identity

Hard delete. Only for identities with no audit trail (e.g., test identities).

- **Auth**: `bearerAuth` (requires `relayauth:identity:delete`)
- **Response 204**: No content

---

### 4. Identities — Sub-agents (`/v1/identities/{identityId}/sub-agents`)

#### POST /v1/identities/{identityId}/sub-agents — Create Sub-agent

Creates a child identity. Scopes are **intersected** with parent. Sponsor chain is extended.

- **Auth**: `bearerAuth` (requires `relayauth:identity:create`)
- **Request Body**:

```yaml
CreateSubAgentRequest:
  type: object
  required: [name]
  properties:
    name:
      type: string
    scopes:
      type: array
      items: { type: string }
      description: Requested scopes (intersected with parent's scopes)
    metadata:
      type: object
      additionalProperties: { type: string }
    ttl:
      type: string
      description: Max lifetime for the sub-agent's tokens
```

- **Response 201**:

```yaml
CreateSubAgentResponse:
  type: object
  required: [identity, tokenPair, sponsorChain]
  properties:
    identity:
      $ref: "#/components/schemas/AgentIdentity"
    tokenPair:
      $ref: "#/components/schemas/TokenPair"
    sponsorChain:
      type: array
      items: { type: string }
      example: ["user_jane", "agent_8x2k", "agent_new"]
```

- **Error 403**: If requested scopes exceed parent's scopes (scope escalation attempt — also creates audit event)

#### GET /v1/identities/{identityId}/sub-agents — List Sub-agents

- **Auth**: `bearerAuth`
- **Response 200**: `PaginatedResponse` of `AgentIdentity`

---

### 5. Roles (`/v1/roles`)

#### POST /v1/roles — Create Role

- **Auth**: `bearerAuth` (requires `relayauth:role:create`)
- **Request Body**:

```yaml
CreateRoleRequest:
  type: object
  required: [name, scopes]
  properties:
    name:
      type: string
      example: "backend-developer"
    description:
      type: string
    scopes:
      type: array
      items: { type: string }
    workspaceId:
      type: string
      description: If set, role is workspace-scoped; otherwise org-wide
```

- **Response 201**: `Role`

```yaml
Role:
  type: object
  required: [id, name, description, scopes, orgId, builtIn, createdAt]
  properties:
    id: { type: string }
    name: { type: string }
    description: { type: string }
    scopes:
      type: array
      items: { type: string }
    orgId: { type: string }
    workspaceId: { type: string }
    builtIn: { type: boolean }
    createdAt: { type: string, format: date-time }
```

#### GET /v1/roles — List Roles

- **Auth**: `bearerAuth` (requires `relayauth:role:read`)
- **Query params**: `workspaceId`, `builtIn`, pagination
- **Response 200**: `PaginatedResponse` of `Role`

#### GET /v1/roles/{roleId} — Get Role

- **Auth**: `bearerAuth` (requires `relayauth:role:read`)
- **Response 200**: `Role`

#### PATCH /v1/roles/{roleId} — Update Role

Cannot update built-in roles.

- **Auth**: `bearerAuth` (requires `relayauth:role:manage`)
- **Request Body**:

```yaml
UpdateRoleRequest:
  type: object
  properties:
    name: { type: string }
    description: { type: string }
    scopes:
      type: array
      items: { type: string }
```

- **Response 200**: `Role`

#### DELETE /v1/roles/{roleId} — Delete Role

Cannot delete built-in roles. Fails if role is still assigned to identities.

- **Auth**: `bearerAuth` (requires `relayauth:role:delete`)
- **Response 204**: No content

#### POST /v1/roles/{roleId}/assign — Assign Role to Identity

- **Auth**: `bearerAuth` (requires `relayauth:role:manage`)
- **Request Body**:

```yaml
AssignRoleRequest:
  type: object
  required: [identityId]
  properties:
    identityId: { type: string }
```

- **Response 204**: No content

#### POST /v1/roles/{roleId}/unassign — Unassign Role from Identity

- **Auth**: `bearerAuth` (requires `relayauth:role:manage`)
- **Request Body**:

```yaml
UnassignRoleRequest:
  type: object
  required: [identityId]
  properties:
    identityId: { type: string }
```

- **Response 204**: No content

---

### 6. Policies (`/v1/policies`)

#### POST /v1/policies — Create Policy

- **Auth**: `bearerAuth` (requires `relayauth:policy:create`)
- **Request Body**:

```yaml
CreatePolicyRequest:
  type: object
  required: [name, effect, scopes]
  properties:
    name:
      type: string
      example: "deny-prod-writes-after-hours"
    effect:
      type: string
      enum: [allow, deny]
    scopes:
      type: array
      items: { type: string }
    conditions:
      type: array
      items:
        $ref: "#/components/schemas/PolicyCondition"
    priority:
      type: integer
      default: 0
      description: Higher priority policies are evaluated first. Deny always wins ties.
    workspaceId:
      type: string
```

```yaml
PolicyCondition:
  type: object
  required: [type, operator, value]
  properties:
    type:
      type: string
      enum: [time, ip, identity, workspace]
    operator:
      type: string
      enum: [eq, neq, in, not_in, gt, lt, matches]
    value:
      oneOf:
        - type: string
        - type: array
          items: { type: string }
```

- **Response 201**: `Policy`

```yaml
Policy:
  type: object
  required: [id, name, effect, scopes, conditions, priority, orgId, createdAt]
  properties:
    id: { type: string }
    name: { type: string }
    effect: { type: string, enum: [allow, deny] }
    scopes:
      type: array
      items: { type: string }
    conditions:
      type: array
      items:
        $ref: "#/components/schemas/PolicyCondition"
    priority: { type: integer }
    orgId: { type: string }
    workspaceId: { type: string }
    createdAt: { type: string, format: date-time }
```

#### GET /v1/policies — List Policies

- **Auth**: `bearerAuth` (requires `relayauth:policy:read`)
- **Query params**: `workspaceId`, `effect`, pagination
- **Response 200**: `PaginatedResponse` of `Policy`

#### GET /v1/policies/{policyId} — Get Policy

- **Auth**: `bearerAuth` (requires `relayauth:policy:read`)
- **Response 200**: `Policy`

#### PATCH /v1/policies/{policyId} — Update Policy

- **Auth**: `bearerAuth` (requires `relayauth:policy:manage`)
- **Request Body**:

```yaml
UpdatePolicyRequest:
  type: object
  properties:
    name: { type: string }
    effect: { type: string, enum: [allow, deny] }
    scopes:
      type: array
      items: { type: string }
    conditions:
      type: array
      items:
        $ref: "#/components/schemas/PolicyCondition"
    priority: { type: integer }
```

- **Response 200**: `Policy`

#### DELETE /v1/policies/{policyId} — Delete Policy

- **Auth**: `bearerAuth` (requires `relayauth:policy:delete`)
- **Response 204**: No content

#### POST /v1/policies/evaluate — Evaluate Policies

Dry-run policy evaluation for a given identity + scope + context.

- **Auth**: `bearerAuth` (requires `relayauth:policy:read`)
- **Request Body**:

```yaml
EvaluatePolicyRequest:
  type: object
  required: [identityId, scope]
  properties:
    identityId: { type: string }
    scope: { type: string }
    context:
      type: object
      properties:
        ip: { type: string }
        timestamp: { type: string, format: date-time }
        workspaceId: { type: string }
```

- **Response 200**:

```yaml
EvaluatePolicyResponse:
  type: object
  required: [result, matchedPolicies]
  properties:
    result:
      type: string
      enum: [allowed, denied]
    matchedPolicies:
      type: array
      items:
        type: object
        properties:
          policyId: { type: string }
          name: { type: string }
          effect: { type: string, enum: [allow, deny] }
    reason:
      type: string
      description: Human-readable explanation of the decision
```

---

### 7. Scopes (`/v1/scopes`)

#### POST /v1/scopes/validate — Validate Scope String

Parse and validate a scope string against the `{plane}:{resource}:{action}:{path?}` format.

- **Auth**: `bearerAuth`
- **Request Body**:

```yaml
ValidateScopeRequest:
  type: object
  required: [scope]
  properties:
    scope:
      type: string
      example: "relaycast:channel:read:*"
```

- **Response 200**:

```yaml
ParsedScope:
  type: object
  required: [plane, resource, action, path, raw]
  properties:
    plane: { type: string, enum: [relaycast, relayfile, cloud, relayauth] }
    resource: { type: string }
    action: { type: string, enum: [read, write, create, delete, manage, run, send, invoke, "*"] }
    path: { type: string }
    raw: { type: string }
```

#### GET /v1/scopes/templates — List Scope Templates

Returns predefined scope bundles.

- **Auth**: `bearerAuth`
- **Response 200**:

```yaml
ScopeTemplatesResponse:
  type: object
  properties:
    templates:
      type: array
      items:
        type: object
        required: [name, description, scopes]
        properties:
          name: { type: string }
          description: { type: string }
          scopes:
            type: array
            items: { type: string }
```

#### POST /v1/scopes/check — Check Scope Access

Check if an identity has a specific scope (considering roles, policies, delegation).

- **Auth**: `bearerAuth`
- **Request Body**:

```yaml
CheckScopeRequest:
  type: object
  required: [identityId, scope]
  properties:
    identityId: { type: string }
    scope: { type: string }
    workspaceId: { type: string }
```

- **Response 200**:

```yaml
CheckScopeResponse:
  type: object
  required: [allowed]
  properties:
    allowed: { type: boolean }
    grantedVia:
      type: string
      enum: [direct, role, inherited]
      description: How the scope was granted
    role:
      type: string
      description: Role name if granted via role
```

---

### 8. Audit (`/v1/audit`)

#### GET /v1/audit — Query Audit Log

- **Auth**: `bearerAuth` (requires `relayauth:audit:read`)
- **Query params** (all optional, maps to `AuditQuery`):
  - `identityId` (string)
  - `action` (string, enum of AuditAction values)
  - `workspaceId` (string)
  - `plane` (string)
  - `result` (string, enum: allowed, denied)
  - `from` (string, ISO 8601)
  - `to` (string, ISO 8601)
  - `cursor`, `limit` (pagination)
- **Response 200**: `PaginatedResponse` of `AuditEntry`

```yaml
AuditEntry:
  type: object
  required: [id, action, identityId, orgId, result, timestamp]
  properties:
    id: { type: string }
    action:
      type: string
      enum:
        - token.issued
        - token.refreshed
        - token.revoked
        - token.validated
        - identity.created
        - identity.updated
        - identity.suspended
        - identity.retired
        - scope.checked
        - scope.denied
        - role.assigned
        - role.removed
        - policy.created
        - policy.updated
        - policy.deleted
        - key.rotated
    identityId: { type: string }
    orgId: { type: string }
    workspaceId: { type: string }
    plane: { type: string }
    resource: { type: string }
    result: { type: string, enum: [allowed, denied, error] }
    metadata:
      type: object
      additionalProperties: { type: string }
    ip: { type: string }
    userAgent: { type: string }
    timestamp: { type: string, format: date-time }
```

#### GET /v1/audit/{entryId} — Get Audit Entry

- **Auth**: `bearerAuth` (requires `relayauth:audit:read`)
- **Response 200**: `AuditEntry`

#### GET /v1/audit/sponsor-chain/{identityId} — Trace Sponsor Chain

Returns the full sponsor chain for an identity with associated audit entries.

- **Auth**: `bearerAuth` (requires `relayauth:audit:read`)
- **Response 200**:

```yaml
SponsorChainResponse:
  type: object
  required: [chain]
  properties:
    chain:
      type: array
      items:
        type: object
        required: [identityId, type]
        properties:
          identityId: { type: string }
          type: { type: string, enum: [human, agent, service] }
          name: { type: string }
          createdBy: { type: string }
```

#### POST /v1/audit/export — Export Audit Log

Trigger async export of audit data.

- **Auth**: `bearerAuth` (requires `relayauth:audit:manage`)
- **Request Body**:

```yaml
ExportAuditRequest:
  type: object
  required: [from, to]
  properties:
    from: { type: string, format: date-time }
    to: { type: string, format: date-time }
    format:
      type: string
      enum: [json, csv]
      default: json
    filter:
      $ref: "#/components/schemas/AuditQuery"
```

- **Response 202**:

```yaml
ExportAuditResponse:
  type: object
  required: [exportId, status]
  properties:
    exportId: { type: string }
    status: { type: string, enum: [pending, processing, complete, failed] }
    downloadUrl: { type: string, description: "Available when status=complete" }
```

#### GET /v1/audit/exports/{exportId} — Get Export Status

- **Auth**: `bearerAuth` (requires `relayauth:audit:read`)
- **Response 200**: `ExportAuditResponse`

---

### 9. Budgets (`/v1/identities/{identityId}/budget`)

#### GET /v1/identities/{identityId}/budget — Get Budget

- **Auth**: `bearerAuth` (requires `relayauth:identity:read`)
- **Response 200**:

```yaml
BudgetResponse:
  type: object
  required: [identityId]
  properties:
    identityId: { type: string }
    maxActionsPerHour: { type: integer, nullable: true }
    maxCostPerDay: { type: number, nullable: true }
    alertThreshold: { type: number, description: "0.0–1.0" }
    autoSuspend: { type: boolean }
    currentActionsThisHour: { type: integer }
    currentCostToday: { type: number }
    alertWebhookUrl: { type: string }
```

#### PUT /v1/identities/{identityId}/budget — Set Budget

- **Auth**: `bearerAuth` (requires `relayauth:identity:manage`)
- **Request Body**:

```yaml
SetBudgetRequest:
  type: object
  properties:
    maxActionsPerHour: { type: integer, nullable: true }
    maxCostPerDay: { type: number, nullable: true }
    alertThreshold: { type: number }
    autoSuspend: { type: boolean }
    alertWebhookUrl: { type: string, format: uri }
```

- **Response 200**: `BudgetResponse`

---

### 10. Admin (`/v1/admin`)

#### POST /v1/admin/keys/rotate — Rotate Signing Keys

- **Auth**: `bearerAuth` (requires `relayauth:admin:manage`)
- **Response 200**:

```yaml
RotateKeysResponse:
  type: object
  required: [newKeyId, oldKeyId, rotatedAt]
  properties:
    newKeyId: { type: string }
    oldKeyId: { type: string }
    rotatedAt: { type: string, format: date-time }
    oldKeyExpiresAt:
      type: string
      format: date-time
      description: Grace period before old key stops validating
```

#### GET /v1/admin/keys — List Signing Keys

- **Auth**: `bearerAuth` (requires `relayauth:admin:read`)
- **Response 200**:

```yaml
ListKeysResponse:
  type: object
  properties:
    keys:
      type: array
      items:
        type: object
        properties:
          keyId: { type: string }
          algorithm: { type: string, enum: [RS256, EdDSA] }
          status: { type: string, enum: [active, rotating, expired] }
          createdAt: { type: string, format: date-time }
          expiresAt: { type: string, format: date-time }
```

#### GET /v1/admin/org — Get Organization Config

- **Auth**: `bearerAuth` (requires `relayauth:admin:read`)
- **Response 200**:

```yaml
OrgConfigResponse:
  type: object
  properties:
    orgId: { type: string }
    name: { type: string }
    maxTokenTTL: { type: string, description: "Maximum allowed token TTL, e.g. '30d'" }
    defaultTokenTTL: { type: string }
    auditRetentionDays: { type: integer }
    allowedAlgorithms:
      type: array
      items: { type: string, enum: [RS256, EdDSA] }
```

#### PATCH /v1/admin/org — Update Organization Config

- **Auth**: `bearerAuth` (requires `relayauth:admin:manage`)
- **Request Body**: Same fields as `OrgConfigResponse` (all optional)
- **Response 200**: `OrgConfigResponse`

---

### 11. Health (`/v1/health`)

#### GET /v1/health — Health Check

Public. No auth required.

- **Response 200**:

```yaml
HealthResponse:
  type: object
  required: [status, version]
  properties:
    status:
      type: string
      enum: [healthy, degraded, unhealthy]
    version:
      type: string
      example: "1.0.0"
    timestamp:
      type: string
      format: date-time
    services:
      type: object
      properties:
        kv: { type: string, enum: [up, down] }
        d1: { type: string, enum: [up, down] }
        do: { type: string, enum: [up, down] }
```

---

## Endpoint Summary Table

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/tokens` | API Key | Issue token pair |
| POST | `/v1/tokens/refresh` | None | Refresh token |
| POST | `/v1/tokens/revoke` | Bearer | Revoke token(s) |
| POST | `/v1/tokens/validate` | Bearer/Key | Validate & introspect token |
| GET | `/v1/tokens/{identityId}` | Bearer | List active tokens |
| GET | `/.well-known/jwks.json` | None | Public JWKS |
| POST | `/v1/identities` | Bearer | Create identity |
| GET | `/v1/identities` | Bearer | List identities |
| GET | `/v1/identities/{identityId}` | Bearer | Get identity |
| PATCH | `/v1/identities/{identityId}` | Bearer | Update identity |
| POST | `/v1/identities/{identityId}/suspend` | Bearer | Suspend identity |
| POST | `/v1/identities/{identityId}/reactivate` | Bearer | Reactivate identity |
| POST | `/v1/identities/{identityId}/retire` | Bearer | Retire identity |
| DELETE | `/v1/identities/{identityId}` | Bearer | Delete identity |
| POST | `/v1/identities/{identityId}/sub-agents` | Bearer | Create sub-agent |
| GET | `/v1/identities/{identityId}/sub-agents` | Bearer | List sub-agents |
| GET | `/v1/identities/{identityId}/budget` | Bearer | Get budget |
| PUT | `/v1/identities/{identityId}/budget` | Bearer | Set budget |
| POST | `/v1/roles` | Bearer | Create role |
| GET | `/v1/roles` | Bearer | List roles |
| GET | `/v1/roles/{roleId}` | Bearer | Get role |
| PATCH | `/v1/roles/{roleId}` | Bearer | Update role |
| DELETE | `/v1/roles/{roleId}` | Bearer | Delete role |
| POST | `/v1/roles/{roleId}/assign` | Bearer | Assign role |
| POST | `/v1/roles/{roleId}/unassign` | Bearer | Unassign role |
| POST | `/v1/policies` | Bearer | Create policy |
| GET | `/v1/policies` | Bearer | List policies |
| GET | `/v1/policies/{policyId}` | Bearer | Get policy |
| PATCH | `/v1/policies/{policyId}` | Bearer | Update policy |
| DELETE | `/v1/policies/{policyId}` | Bearer | Delete policy |
| POST | `/v1/policies/evaluate` | Bearer | Dry-run policy eval |
| POST | `/v1/scopes/validate` | Bearer | Validate scope string |
| GET | `/v1/scopes/templates` | Bearer | List scope templates |
| POST | `/v1/scopes/check` | Bearer | Check scope access |
| GET | `/v1/audit` | Bearer | Query audit log |
| GET | `/v1/audit/{entryId}` | Bearer | Get audit entry |
| GET | `/v1/audit/sponsor-chain/{identityId}` | Bearer | Trace sponsor chain |
| POST | `/v1/audit/export` | Bearer | Export audit data |
| GET | `/v1/audit/exports/{exportId}` | Bearer | Get export status |
| POST | `/v1/admin/keys/rotate` | Bearer | Rotate signing keys |
| GET | `/v1/admin/keys` | Bearer | List signing keys |
| GET | `/v1/admin/org` | Bearer | Get org config |
| PATCH | `/v1/admin/org` | Bearer | Update org config |
| GET | `/v1/health` | None | Health check |

---

## Rate Limiting

All endpoints return rate limit headers:
- `X-RateLimit-Limit` — requests per window
- `X-RateLimit-Remaining` — remaining in current window
- `X-RateLimit-Reset` — UTC epoch seconds when window resets

When exceeded, returns **429** with `Retry-After` header.

## Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Per endpoint | `Bearer <jwt>` |
| `X-API-Key` | Token issuance | Organization API key |
| `X-Request-Id` | Optional | Client-provided request ID (echoed in response) |
| `X-Workspace-Id` | Optional | Override workspace context |

## Response Headers

| Header | Description |
|--------|-------------|
| `X-Request-Id` | Request ID (generated or echoed) |
| `X-RateLimit-*` | Rate limit info |
