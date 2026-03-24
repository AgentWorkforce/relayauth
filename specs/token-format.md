# Token Format Specification

## Purpose

This document defines the relayauth token envelope, claim set, signing rules,
JWKS publishing contract, key rotation behavior, and token-pair semantics.

relayauth issues JWTs that are validated at the edge by any plane in the Agent
Relay ecosystem. Every token is scoped, attributable to a human sponsor, and
time-bounded. Permanent tokens are not allowed.

## JWT Structure

relayauth tokens are JSON Web Tokens in compact serialization:

```text
base64url(header).base64url(payload).base64url(signature)
```

### Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "ra_2026_03_access_a1b2c3"
}
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `alg` | `string` | Yes | Must be `RS256` or `EdDSA`. Verifiers must reject any other value. |
| `typ` | `string` | Yes | Must be `JWT`. |
| `kid` | `string` | Yes | Must identify a currently published or grace-period key in JWKS. |

### Payload

The payload contains the standard claims and relayauth-specific authorization
claims described below.

### Signature

The signature is produced with the private key referenced by `kid`.

- `RS256` uses `RSASSA-PKCS1-v1_5` with `SHA-256`
- `EdDSA` uses `Ed25519`

Verifiers must select the verification key by `kid` first, then enforce that
the JWK algorithm metadata and token header algorithm agree.

## Claims

The canonical claim shape extends the current `RelayAuthTokenClaims` interface.

### Required Claims

| Claim | Type | Required | Validation Rules |
| --- | --- | --- | --- |
| `sub` | `string` | Yes | Agent identity ID. Must match `^agent_[A-Za-z0-9_-]+$`. |
| `org` | `string` | Yes | Organization ID. Must match `^org_[A-Za-z0-9_-]+$`. |
| `wks` | `string` | Yes | Workspace ID. Must match `^ws_[A-Za-z0-9_-]+$`. |
| `scopes` | `string[]` | Yes | Must be a non-empty array for access tokens. Each value must follow `{plane}:{resource}:{action}` or `{plane}:{resource}:{action}:{constraint}`. |
| `sponsorId` | `string` | Yes | Human sponsor ID. Must match `^user_[A-Za-z0-9_-]+$`. |
| `sponsorChain` | `string[]` | Yes | Must contain at least 2 entries for agent tokens. Index `0` must be `sponsorId`. Last entry should match `sub`. |
| `iss` | `string` | Yes | Must equal `https://relayauth.dev`. |
| `aud` | `string[]` | Yes | Must be a non-empty array. The validating service identifier must be included. |
| `exp` | `number` | Yes | Unix timestamp in seconds. Must be greater than `iat`. Mandatory for every token. |
| `iat` | `number` | Yes | Unix timestamp in seconds. Must not be meaningfully in the future. |
| `jti` | `string` | Yes | Token ID. Must match `^tok_[A-Za-z0-9_-]+$`. |
| `token_type` | `"access" \| "refresh"` | Yes | Distinguishes access from refresh tokens. Verifiers must reject a token presented in a context that does not match its `token_type`. |

### Optional Claims

| Claim | Type | Required | Validation Rules |
| --- | --- | --- | --- |
| `nbf` | `number` | No | Unix timestamp in seconds. If present, verifiers must reject the token before this time (with the same 60-second clock skew allowance). Useful for scheduled or deferred token activation. |
| `sid` | `string` | No | Session identifier for correlating token rotation and logout. |
| `meta` | `Record<string, string>` | No | Application metadata. Keys and values must be strings. Keep small enough to avoid token bloat. |
| `parentTokenId` | `string` | No | If present, must match `^tok_[A-Za-z0-9_-]+$` and identify the parent token used for delegation. |
| `budget` | `TokenBudget` | No | Optional behavioral budget snapshot. Values must be non-negative. |

### `budget` Object

| Field | Type | Required | Validation Rules |
| --- | --- | --- | --- |
| `maxActionsPerHour` | `number` | No | Integer >= 0. |
| `maxCostPerDay` | `number` | No | Decimal or integer >= 0, interpreted in organization billing currency. |
| `remaining` | `number` | No | Integer >= 0. Informational snapshot only; authoritative state lives in Durable Objects. |

### Claim Semantics

#### Sponsor Chain

- `sponsorId` is the human accountable for the agent.
- `sponsorChain` records the full lineage from the human sponsor to the current
  agent.
- Example root agent chain: `["user_jane", "agent_8x2k"]`
- Example delegated chain: `["user_jane", "agent_8x2k", "agent_9y3m"]`

#### Delegation

If `parentTokenId` is present:

- the child token was minted from another token
- the child `scopes` must be an intersection or strict narrowing of the parent
  scopes
- the child `exp` must be less than or equal to the parent `exp`
- the child `budget`, if present, must be equal or more restrictive than the
  parent budget
- any attempted escalation is a hard issuance error and an audit event
- the maximum delegation depth (length of `sponsorChain`) is 10. Issuance must
  fail if a delegation would exceed this depth. This prevents unbounded chain
  growth, token bloat, and overly complex audit trails.

#### Audience

- Access tokens can be multi-audience
- A service must reject a token if its own audience identifier is absent
- Refresh tokens are single-audience and must use `["relayauth"]`

## Claim Validation Rules

All verifiers must perform these checks in order:

1. Parse the JWT as exactly three dot-separated segments.
2. Decode header and payload as valid UTF-8 JSON objects.
3. Resolve `kid` in JWKS.
4. Verify the signature using the algorithm in `alg`.
5. Reject if `alg` is not allowed for the resolved key.
6. Reject if `iss !== "https://relayauth.dev"`.
7. Reject if the current service is not present in `aud`.
8. Reject if `exp` is in the past. Allow at most 60 seconds clock skew.
9. Reject if `iat` is more than 60 seconds in the future.
10. Reject if `jti` is revoked (see [Revocation Mechanism](#revocation-mechanism)).
11. Reject if required scope checks fail for the requested operation.
12. Reject delegated tokens whose scopes or expiry exceed the parent token.

## Signing Algorithms

### RS256

`RS256` is the default signing algorithm.

- Algorithm: RSA PKCS #1 v1.5 with SHA-256
- Minimum key size: 3072-bit for new deployments. 2048-bit is permitted only
  for legacy integrations and must be sunset by 2028-01-01. 4096-bit is
  acceptable where performance allows.
- Reason: maximum JWT ecosystem compatibility across SDKs, gateways, and legacy
  libraries

Implementation rules:

- JWKS key must use `kty: "RSA"`
- JWK must include `n` and `e`
- `use` must be `sig`
- `alg` should be `RS256`

### EdDSA

`EdDSA` is supported for organizations or deployments that want smaller keys and
faster verification with modern tooling.

- Algorithm: Ed25519
- Key type: Octet Key Pair
- Reason: smaller signatures, lower CPU cost, strong modern primitive

Implementation rules:

- JWKS key must use `kty: "OKP"`
- JWK must include `crv: "Ed25519"` and `x`
- `use` must be `sig`
- `alg` should be `EdDSA`

### Algorithm Safety Rules

- Do not permit `alg: "none"`
- Do not algorithm-switch based on untrusted input without matching `kid`
- Do not accept symmetric algorithms (`HS256`, `HS384`, `HS512`) for these tokens
- Do not accept non-permitted asymmetric algorithm families: `RS384`, `RS512`,
  `ES256`, `ES384`, `ES512`, `PS256`, `PS384`, `PS512`. Only `RS256` and `EdDSA`
  are allowed.
- Verifiers must reject a token if header `alg` and JWK `alg` conflict

## JWKS Endpoint

Public verification keys are published at:

```text
GET /.well-known/jwks.json
```

### Response Shape

```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "ra_2026_03_access_a1b2c3",
      "n": "<base64url modulus>",
      "e": "AQAB"
    },
    {
      "kty": "OKP",
      "use": "sig",
      "alg": "EdDSA",
      "kid": "ra_2026_03_edge_d4e5f6",
      "crv": "Ed25519",
      "x": "<base64url public key>"
    }
  ]
}
```

### Endpoint Contract

- Response content type: `application/json`
- Shape must match `JWKSResponse`:

```ts
export interface JWKSResponse {
  keys: JsonWebKey[];
}
```

- Only active and grace-period signing keys may be present
- Private key material must never be exposed
- Published keys should omit `key_ops` or set it to `["verify"]`. Do not
  include `sign` in `key_ops` for published keys.
- The `x5c` and `x5t` fields are intentionally omitted. relayauth uses a
  self-contained JWKS model without X.509 certificate chains, to prevent
  certificate chain confusion attacks.
- Recommended caching header: `Cache-Control: public, max-age=3600, must-revalidate`
- If a verifier encounters an unknown `kid`, it should re-fetch the JWKS
  endpoint (respecting a minimum re-fetch interval of 60 seconds to prevent
  abuse) before rejecting the token. This handles key rotation propagation
  delays.

## Key Rotation

### `kid` Convention

`kid` values must be unique and human-readable enough for incident response.

Recommended format:

```text
ra_<yyyy>_<mm>_<purpose>_<suffix>
```

Examples:

- `ra_2026_03_access_a1b2c3`
- `ra_2026_03_refresh_d4e5f6`
- `ra_2026_03_edge_f7g8h9`

Rules:

- `<suffix>` should be a short URL-safe random identifier
- `kid` uniqueness must be global across all still-valid keys
- `kid` must not be reused, even after key retirement

### Rotation Behavior

- Planned rotation cadence: every 90 days
- Emergency rotation: immediate on compromise or suspected compromise
- Grace period: 72 hours after a planned rotation

Planned rotation sequence:

1. Generate a new signing key pair.
2. Publish the new public key in JWKS with a new `kid`.
3. Start signing newly issued tokens with the new private key.
4. Keep the old public key in JWKS for 72 hours.
5. Remove the old public key after the grace period ends.

Emergency rotation sequence:

1. Generate and publish a new key immediately.
2. Stop signing with the compromised key immediately.
3. Remove the compromised public key from JWKS without waiting for grace.
4. Force refresh or re-authentication for impacted sessions.

Operational constraints:

- Access token maximum lifetime must remain shorter than the overlap window so
  normally-issued access tokens survive planned rotations without validation
  failures.
- Refresh tokens may outlive the key rotation grace period (e.g., a 30-day
  refresh token vs. a 72-hour grace). During the refresh flow, the server must
  re-sign the new token pair with the current active key. A refresh token whose
  signing key has been retired should be treated as expired, triggering
  re-authentication. This is acceptable because refresh tokens are only
  presented to relayauth itself (not edge verifiers), and relayauth can
  maintain a longer key verification window internally.

## Revocation Mechanism

Token revocation is tracked by `jti`. The revocation system has two tiers:

### Hot Path (Edge Verification)

- A Bloom filter of revoked `jti` values is replicated to edge verifiers via
  Cloudflare KV with a replication target of under 30 seconds.
- False positives from the Bloom filter trigger a fallback lookup against the
  authoritative store. False negatives are bounded by the replication lag.
- The Bloom filter is rebuilt periodically (every 15 minutes) to remove expired
  entries and keep the filter size bounded.

### Authoritative Store

- The canonical revocation set is maintained in a Durable Object
  (`TokenRevocationDO`), keyed by organization.
- Revocation entries are stored with the `jti` and the token's `exp`, so
  entries can be garbage-collected after expiry.
- `jti` uniqueness is enforced at issuance time by the token issuance Durable
  Object, which maintains a set of recently issued `jti` values.

### Revocation Propagation Latency

- Target: revocation should propagate to edge verifiers within 30 seconds
  under normal conditions.
- Worst case: up to 60 seconds during KV replication lag spikes.
- During this window, a revoked token may still be accepted. This is an
  accepted trade-off for edge verification performance.

## Token Pair Semantics

relayauth returns a token pair:

```ts
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  tokenType: "Bearer";
}
```

### Access Token

- Purpose: authorize API calls against product planes
- Transport: `Authorization: Bearer <accessToken>`
- Default lifetime: 1 hour
- Maximum lifetime: 24 hours
- Typical audiences: `relaycast`, `relayfile`, `cloud`
- Must carry the scopes used at authorization time

### Refresh Token

- Purpose: obtain a new token pair from relayauth
- Audience: `["relayauth"]`
- Default lifetime: 24 hours
- Maximum lifetime: 30 days
- Must never be accepted as an authorization token for product-plane APIs
- Must be stored more carefully than the access token

### Refresh Rotation Rules

- Refresh tokens are single-use in principle
- Successful refresh should issue:
  - a new access token
  - a new refresh token
- The previous refresh token should be revoked immediately after use
- Reuse of a revoked refresh token should trigger session invalidation and an
  audit event

### Expiry Rules

- Every access token and refresh token must include `exp`
- Organizations may configure shorter lifetimes
- No token may exceed 30 days lifetime
- Delegated tokens may never outlive their parent token

## Example Access Token

The example below is illustrative. The signature segment is redacted.

### Encoded

```text
eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJhXzIwMjZfMDNfYWNjZXNzX2ExYjJjMyJ9.eyJzdWIiOiJhZ2VudF84eDJrIiwib3JnIjoib3JnX2FjbWUiLCJ3a3MiOiJ3c19wcm9kIiwic2NvcGVzIjpbInJlbGF5Y2FzdDpjaGFubmVsOnJlYWQ6KiIsInJlbGF5ZmlsZTpmczp3cml0ZTovc3JjL2FwaS8qIiwiY2xvdWQ6d29ya2Zsb3c6cnVuIl0sInNwb25zb3JJZCI6InVzZXJfamFuZSIsInNwb25zb3JDaGFpbiI6WyJ1c2VyX2phbmUiLCJhZ2VudF84eDJrIl0sImJ1ZGdldCI6eyJtYXhBY3Rpb25zUGVySG91ciI6MTAwLCJtYXhDb3N0UGVyRGF5Ijo1MCwicmVtYWluaW5nIjo5NH0sImlzcyI6Imh0dHBzOi8vcmVsYXlhdXRoLmRldiIsImF1ZCI6WyJyZWxheWNhc3QiLCJyZWxheWZpbGUiLCJjbG91ZCJdLCJleHAiOjE3NzIwMDQwMDAsImlhdCI6MTc3MjAwMDQwMCwianRpIjoidG9rX2ExYjJjM2Q0ZTVmNmc3aDhpOWowayIsInNpZCI6InNlc3NfbTNrZjlhIiwibWV0YSI6eyJlbnZpcm9ubWVudCI6InByb2R1Y3Rpb24ifX0.<signature>
```

### Decoded Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "ra_2026_03_access_a1b2c3"
}
```

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
  "token_type": "access",
  "budget": {
    "maxActionsPerHour": 100,
    "maxCostPerDay": 50,
    "remaining": 94
  },
  "iss": "https://relayauth.dev",
  "aud": ["relaycast", "relayfile", "cloud"],
  "exp": 1772004000,
  "iat": 1772000400,
  "jti": "tok_a1b2c3d4e5f6g7h8i9j0k",
  "sid": "sess_m3kf9a",
  "meta": {
    "environment": "production"
  }
}
```

## Example Refresh Token

The refresh token is also a JWT, but it is audience-restricted and not valid for
normal product-plane API authorization.

### Encoded

```text
eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InJhXzIwMjZfMDNfcmVmcmVzaF9kNGU1ZjYifQ.eyJzdWIiOiJhZ2VudF84eDJrIiwib3JnIjoib3JnX2FjbWUiLCJ3a3MiOiJ3c19wcm9kIiwic2NvcGVzIjpbInJlbGF5YXV0aDp0b2tlbjpyZWZyZXNoIl0sInNwb25zb3JJZCI6InVzZXJfamFuZSIsInNwb25zb3JDaGFpbiI6WyJ1c2VyX2phbmUiLCJhZ2VudF84eDJrIl0sImlzcyI6Imh0dHBzOi8vcmVsYXlhdXRoLmRldiIsImF1ZCI6WyJyZWxheWF1dGgiXSwiZXhwIjoxNzcyMDg2ODAwLCJpYXQiOjE3NzIwMDA0MDAsImp0aSI6InRva19yMXMydDN1NHY1dzZ4N3k4ejlhMGIiLCJzaWQiOiJzZXNzX20za2Y5YSJ9.<signature>
```

### Decoded Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "ra_2026_03_refresh_d4e5f6"
}
```

### Decoded Payload

```json
{
  "sub": "agent_8x2k",
  "org": "org_acme",
  "wks": "ws_prod",
  "scopes": ["relayauth:token:refresh"],
  "sponsorId": "user_jane",
  "sponsorChain": ["user_jane", "agent_8x2k"],
  "token_type": "refresh",
  "iss": "https://relayauth.dev",
  "aud": ["relayauth"],
  "exp": 1772086800,
  "iat": 1772000400,
  "jti": "tok_r1s2t3u4v5w6x7y8z9a0b",
  "sid": "sess_m3kf9a"
}
```

## Type Alignment

The current public type surface should be extended to match this spec:

```ts
export interface TokenBudget {
  maxActionsPerHour?: number;
  maxCostPerDay?: number;
  remaining?: number;
}

export interface RelayAuthTokenClaims {
  sub: string;
  org: string;
  wks: string;
  scopes: string[];
  sponsorId: string;
  sponsorChain: string[];
  token_type: "access" | "refresh";
  iss: string;
  aud: string[];
  exp: number;
  iat: number;
  jti: string;
  nbf?: number;
  sid?: string;
  meta?: Record<string, string>;
  parentTokenId?: string;
  budget?: TokenBudget;
}
```

## Summary

This specification defines:

- the JWT header, payload, and signature contract
- the full relayauth claim set and its validation rules, including `token_type`
  for access/refresh disambiguation and optional `nbf` for deferred activation
- supported signing algorithms: `RS256` and `EdDSA` (all others explicitly
  prohibited)
- the `/.well-known/jwks.json` response format with `key_ops` and cache-miss
  re-fetch guidance
- `kid` conventions and 90-day rotation with 72-hour grace, including refresh
  token handling across rotation boundaries
- the `jti`-based revocation mechanism using Bloom filters at the edge and
  Durable Objects as the authoritative store
- token pair behavior for access and refresh tokens
- delegation constraints including a maximum chain depth of 10
- concrete encoded and decoded token examples
