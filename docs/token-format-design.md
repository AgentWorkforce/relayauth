# Token Format Design Specification

## 1. JWT Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "relayauth_2024_01_a1b2c3"
}
```

| Field | Description |
|-------|-------------|
| `alg` | **RS256** (primary, broad compatibility) or **EdDSA** (Ed25519, higher performance, smaller signatures). RS256 is the default; EdDSA is opt-in per organization. |
| `typ` | Always `"JWT"`. |
| `kid` | Key ID referencing the signing key in JWKS. Format: `relayauth_{year}_{month}_{nanoid(6)}`. Used for key rotation — validators match `kid` to the correct public key. |

## 2. JWT Claims (Payload)

### 2.1 Standard Claims

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `sub` | `string` | Yes | Agent identity ID. Format: `agent_xxxx` (nanoid). |
| `iss` | `string` | Yes | Issuer. Always `"https://relayauth.dev"`. |
| `aud` | `string[]` | Yes | Target planes/services. e.g., `["relaycast", "relayfile", "cloud"]`. Validators reject tokens not addressed to them. |
| `exp` | `number` | **Yes (MANDATORY)** | Expiration time (Unix seconds). Every token must have `exp`. No permanent tokens. See Section 5 for lifetime rules. |
| `iat` | `number` | Yes | Issued-at time (Unix seconds). |
| `jti` | `string` | Yes | Unique token ID. Format: `tok_xxxx` (nanoid, 21 chars). Used for revocation lookups and audit correlation. |

### 2.2 RelayAuth Claims

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `org` | `string` | Yes | Organization ID. Format: `org_xxxx`. |
| `wks` | `string` | Yes | Workspace ID. Format: `ws_xxxx`. Tokens are scoped to a single workspace. |
| `scopes` | `string[]` | Yes | Granted capabilities. Format: `{plane}:{resource}:{action}:{path?}`. See architecture for examples. |
| `sid` | `string` | No | Session ID for correlating multiple tokens within a session. |
| `meta` | `Record<string, string>` | No | Arbitrary key-value metadata. Max 10 keys, 256 chars per value. For application-specific context (e.g., `environment: "production"`). |

### 2.3 Sponsor & Delegation Claims

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `sponsorId` | `string` | **Yes** | Human user ID accountable for this agent. Format: `user_xxxx`. Every agent traces back to a human — this is non-negotiable. |
| `sponsorChain` | `string[]` | Yes | Full delegation chain from human to this agent. e.g., `["user_jane", "agent_A", "agent_B"]`. First element is always a human (`user_*`). Used for audit trail queries. |
| `parentTokenId` | `string` | No | The `jti` of the parent token that created this sub-agent token. Present only for delegated tokens. **Constraint:** sub-agent scopes must be a strict subset (intersection) of the parent token's scopes. Attempting to escalate is a hard error + audit event. |

### 2.4 Budget Claims

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `budget` | `object` | No | Behavioral rate limits for this identity. |
| `budget.maxActionsPerHour` | `number` | No | Maximum API actions per hour. |
| `budget.maxCostPerDay` | `number` | No | Spending cap (USD) for metered APIs per day. |
| `budget.remaining` | `number` | No | Remaining actions in current window. Updated by the Identity Durable Object, not re-issued per request. Informational in the token — authoritative state lives in the DO. |

## 3. Full Token Example

### Decoded Payload

```json
{
  "sub": "agent_8x2k",
  "org": "org_acme",
  "wks": "ws_prod",
  "scopes": [
    "relaycast:channel:read:*",
    "relayfile:fs:write:/src/api/*",
    "cloud:workflow:run"
  ],
  "sponsorId": "user_jane",
  "sponsorChain": ["user_jane", "agent_8x2k"],
  "parentTokenId": null,
  "budget": {
    "maxActionsPerHour": 100,
    "maxCostPerDay": 50,
    "remaining": 94
  },
  "sid": "sess_m3kf9a",
  "meta": {
    "environment": "production"
  },
  "iss": "https://relayauth.dev",
  "aud": ["relaycast", "relayfile", "cloud"],
  "exp": 1711324800,
  "iat": 1711321200,
  "jti": "tok_a1b2c3d4e5f6g7h8i9j0k"
}
```

### Sub-Agent Delegated Token

```json
{
  "sub": "agent_9y3m",
  "org": "org_acme",
  "wks": "ws_prod",
  "scopes": [
    "relaycast:channel:read:*"
  ],
  "sponsorId": "user_jane",
  "sponsorChain": ["user_jane", "agent_8x2k", "agent_9y3m"],
  "parentTokenId": "tok_a1b2c3d4e5f6g7h8i9j0k",
  "budget": {
    "maxActionsPerHour": 50,
    "remaining": 50
  },
  "iss": "https://relayauth.dev",
  "aud": ["relaycast"],
  "exp": 1711324800,
  "iat": 1711321200,
  "jti": "tok_x9y8z7w6v5u4t3s2r1q0p"
}
```

Note: `scopes` is a subset of the parent's scopes. `sponsorChain` extends the parent's chain. `budget` can only be equal or more restrictive.

## 4. Signing Algorithms

### RS256 (Primary)

- **Algorithm:** RSASSA-PKCS1-v1_5 with SHA-256
- **Key size:** 2048-bit RSA minimum, 4096-bit recommended
- **Use case:** Default for all tokens. Broad ecosystem compatibility (every JWT library supports RS256).
- **Trade-off:** Larger signatures (~342 bytes), slower signing (~1ms)

### EdDSA (Optional)

- **Algorithm:** Ed25519
- **Key size:** 256-bit (fixed)
- **Use case:** Organizations that opt in for performance. Smaller tokens, faster signing/verification.
- **Trade-off:** Narrower library support (most modern libraries support it, but some legacy systems don't).
- **Selection:** Per-organization configuration. The `kid` in the header determines which key (and thus algorithm) to use for verification.

## 5. Token Lifetime

### Mandatory Expiry Policy

**Every token MUST have an `exp` claim. No exceptions. No permanent tokens.**

| Token Type | Default | Minimum | Maximum |
|-----------|---------|---------|---------|
| Access token | **1 hour** | 5 minutes | 24 hours |
| Refresh token | **24 hours** | 1 hour | 30 days |

- Organizations can configure shorter lifetimes, never longer than the maximum.
- Sub-agent tokens inherit the parent's `exp` or use a shorter value — they can never outlive the parent token.
- Clock skew tolerance: **30 seconds** for validation.

### Token Pair Semantics

- **Access token:** Short-lived, included in every API request as `Authorization: Bearer <token>`. Validated at the edge (Cloudflare Workers) using JWKS — no callback to the auth server.
- **Refresh token:** Longer-lived, used only to obtain new access tokens via `POST /v1/token/refresh`. Stored securely by the client SDK. Rotation: each refresh issues a new refresh token and invalidates the old one (refresh token rotation).

## 6. Token ID Format

- Format: `tok_` + nanoid(21)
- Example: `tok_a1b2c3d4e5f6g7h8i9j0k`
- Character set: `A-Za-z0-9_-` (URL-safe)
- Used as the `jti` claim
- Indexed in KV for O(1) revocation lookups

## 7. JWKS Format

### Endpoint

`GET /.well-known/jwks.json` — publicly accessible, no authentication required.

### Response Structure

```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "relayauth_2024_01_a1b2c3",
      "n": "<base64url-encoded modulus>",
      "e": "AQAB"
    },
    {
      "kty": "OKP",
      "use": "sig",
      "alg": "EdDSA",
      "crv": "Ed25519",
      "kid": "relayauth_2024_02_d4e5f6",
      "x": "<base64url-encoded public key>"
    }
  ]
}
```

### Key Rotation Semantics

1. **`kid` convention:** `relayauth_{year}_{month}_{nanoid(6)}`. The year/month prefix allows humans to quickly identify key age.
2. **Rotation cadence:** Keys rotate every 90 days by default. Can be triggered manually for incident response.
3. **Grace period:** When a new key is introduced, the old key remains in JWKS for **72 hours** (overlap window). Tokens signed with the old key continue to validate during this window.
4. **Rotation sequence:**
   - Generate new key pair, add public key to JWKS with new `kid`
   - Switch signing to new key (new tokens use new `kid`)
   - After 72 hours, remove old public key from JWKS
   - Old tokens signed with removed key will fail validation (they should have expired or been refreshed by then)
5. **Emergency rotation:** Immediately remove compromised key from JWKS. All tokens signed with that key become invalid. Clients must re-authenticate.
6. **Cache headers:** JWKS response includes `Cache-Control: public, max-age=3600` (1 hour). Validators should cache but respect this TTL.

## 8. Validation Rules

Validators (at the edge or in any service) MUST check:

1. **Signature** — verify against JWKS using the `kid` from the header
2. **`exp`** — token is not expired (with 30s clock skew tolerance)
3. **`iat`** — issued-at is not in the future
4. **`iss`** — matches `"https://relayauth.dev"`
5. **`aud`** — contains the validating service's identifier
6. **`sub`** — is a valid identity format (`agent_*`, `user_*`, or `svc_*`)
7. **Revocation** — check `jti` against KV revocation list (< 1s propagation)
8. **Scopes** — the required scope for the endpoint is present in `scopes` (checked by middleware, not at JWT validation layer)

## 9. Type Updates Required

The current `RelayAuthTokenClaims` interface needs the following additions to match this spec:

```typescript
export interface RelayAuthTokenClaims {
  sub: string;
  org: string;
  wks: string;
  scopes: string[];
  iss: string;
  aud: string[];
  exp: number;
  iat: number;
  jti: string;
  sid?: string;
  meta?: Record<string, string>;
  // New fields
  sponsorId: string;
  sponsorChain: string[];
  parentTokenId?: string;
  budget?: TokenBudget;
}

export interface TokenBudget {
  maxActionsPerHour?: number;
  maxCostPerDay?: number;
  remaining?: number;
}
```
