# Spec: API keys + RS256 production migration

## Status

Proposed.

## Problem

Production relayauth (`https://api.relayauth.dev`) is out of step with three
contracts that other Agent Relay services already depend on:

1. **`specs/token-format.md` mandates `RS256` or `EdDSA`** and says *"verifiers
   must reject any other value."* Production today signs and serves
   `{"alg":"HS256","kid":"production"}` from JWKS. Every published verifier
   (e.g. `@relayauth/sdk`'s `TokenVerifier` at `verify.js:184-200`) refuses
   `HS256` outright, so any consumer that follows the spec cannot verify
   production tokens at all.

2. **`POST /v1/tokens` is unimplemented.** The discovery endpoint advertises
   it (`routes/discovery.ts:165`), the OpenAPI spec lists it, the
   `@relayauth/sdk`'s `client.issueToken(...)` posts to it — but there's no
   route handler registered in `packages/server/src/server.ts` (only
   identities, roles, policies, audit, dashboard stats, observer,
   discovery, jwks). Cloud's e2e tests in
   `cloud/packages/relayauth/src/__tests__/e2e/*.test.ts` mock the route
   with their own fetch handler; production has no such mock. So
   `mintRelayfileToken`'s "production" path can't actually mint anything,
   which is part of why every consumer (sage included) silently falls back
   to the legacy HS256 helper.

3. **There is no programmatic way to obtain credentials.** The OpenAPI spec
   and `__tests__/e2e/contract.test.ts` both reference `POST /v1/api-keys`,
   `GET /v1/api-keys`, and `POST /v1/api-keys/:id/revoke`. None of those
   routes exist in `packages/server/src/routes/`, and there is no
   `api_keys` table in `db/migrations/0001_local_bootstrap.sql`. Identity
   creation (`POST /v1/identities`) requires a bearer token, not an
   `x-api-key` header — meaning any new service that wants to call relayauth
   first needs an admin to hand them a long-lived JWT out of band.

The user-visible failure that surfaced this: cloud's specialist worker
adopted RS256/JWKS-style auth on `/a2a/rpc` (cloud #267), sage was supposed
to mint via relayauth and present the resulting bearer, but neither side
of that chain works — sage has no API key path, relayauth has no RS256
key, and even if it did, no API key endpoint exists to issue it. Result:
sage's specialist tool calls 401 every time, the harness model retries
across all 8 iterations, sage falls back to *"I could not complete that
request right now."* in Slack.

## Goals

1. Bring production signing in line with `token-format.md` (`RS256`).
2. Implement the API key surface the OpenAPI spec already advertises.
3. Cut over without breaking any currently-issued tokens (1-hour TTL, so
   the dual-verify window is short).
4. Enable sage → specialist auth (and any future service-to-service auth)
   without requiring a human to hand-craft long-lived bearers.

## Non-goals

- Replacing the existing identity/token model. The claim shape from
  `token-format.md` is correct; only the signing algorithm changes.
- Multi-issuer / per-tenant signing keys. One issuer, one active signing
  key, plus key-rotation hooks for the future.
- Rate limiting on API key creation. That's a follow-up; for now this is
  an internal API used by other Agent Relay services, not customer-facing.

## Architecture

### Target state

```
                           ┌─────────────────────────────────────┐
                           │  RelayAuth control plane             │
                           │                                       │
   admin operator ──bearer▶│  POST /v1/api-keys ──► returns "key" │
                           │  GET  /v1/api-keys                    │
                           │  POST /v1/api-keys/:id/revoke         │
                           └─────────────────────────────────────┘
                                          │
       sage (or any service)              │ x-api-key: ${key}
                ▼                         ▼
       ┌────────────────────┐    ┌──────────────────────────────┐
       │ POST /v1/identities│───▶│ identities table              │
       │ POST /v1/tokens    │───▶│ RS256 sign, return TokenPair  │
       └────────────────────┘    └──────────────────────────────┘
                                          │
                                          ▼
                             RS256-signed JWT (audience: ["specialist"])
                                          │
                                          ▼
       ┌──────────────────────────────────────────────────────────┐
       │ specialist /a2a/rpc                                       │
       │   verifyBearerToken(token) ──► fetch JWKS                 │
       │   ──► find {kty:"RSA", kid:"production-2026-04"}          │
       │   ──► verify(RS256) → claims                              │
       └──────────────────────────────────────────────────────────┘
```

### Current state vs. target

| Surface | Today | Target |
|---|---|---|
| JWKS `alg` | `HS256`, no public key material | `RS256`, with `n`/`e` of RSA public key |
| Token signing | HMAC-SHA256 with shared secret | RSA private key, never leaves the issuer |
| Token verification | Fails for any spec-compliant verifier (no path for HS256 in `TokenVerifier`) | Works for any `RS256`/`EdDSA` verifier following `token-format.md` |
| API key issuance | Endpoints declared in OpenAPI, *not implemented* | Implemented; admin bearer creates initial keys, optionally an API key can create downstream keys |
| `POST /v1/identities` auth | `Authorization: Bearer <admin JWT>` only | Either `Authorization: Bearer …` *or* `x-api-key: …` |
| `POST /v1/tokens` auth | `Authorization: Bearer <admin JWT>` only | Either `Authorization: Bearer …` *or* `x-api-key: …` |

## Repo split

Important context: `@relayauth/server` (the npm package, source in this
relayauth repo) provides the Hono routes + storage *interfaces*. The
*deployed* worker lives in `cloud/packages/relayauth/` and provides the
Cloudflare-specific implementations (D1 storage, KV revocation, Durable
Objects, worker entrypoint, db migrations).

So most phases below have **two PRs each**: one in this repo for the
route/storage-interface layer, one in cloud for the D1 migration +
Cloudflare adapter implementation. `cloud/packages/relayauth` then bumps
the `@relayauth/server` dep to pick up the route changes; SST deploys
the new worker.

## Implementation plan

Phased to keep production verifiable at every step.

### Phase 0 — `/v1/tokens` route

Precondition for everything else. Without a working token endpoint, API
keys have nothing useful to authenticate to. Self-contained PR in
relayauth, no behavior change for existing consumers (which all use the
legacy HS256 helper today).

**New file `packages/server/src/routes/tokens.ts`:**

- `POST /v1/tokens` (auth: bearer or x-api-key — bearer-only initially,
  x-api-key wired in Phase 1)
  Body: `{ identityId, scopes?, audience?, expiresIn? }`
  Looks up identity, builds claims per `specs/token-format.md`, signs
  using whichever helper is active (HS256 today, RS256 after Phase 2),
  persists to `tokens` table for revocation lookups, returns
  `{ accessToken, refreshToken?, expiresAt }`.

- `POST /v1/tokens/refresh` — refresh-token exchange (defer if not yet
  needed; consumers using sage-style "mint a fresh access token per
  call" don't need refresh).

- `POST /v1/tokens/revoke` — write to revocations table.

- `GET /v1/tokens/introspect` — returns claims if token is currently
  valid; 404 / 410 otherwise.

Wire into `server.ts` alongside existing `app.route("/v1/...", ...)`
calls. Tests in `__tests__/tokens-issue.test.ts`.

### Phase 1 — API key endpoint + storage

PR 1 in relayauth, depends on Phase 0.

**Schema (new migration `0002_api_keys.sql`):**

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,                      -- e.g. "ak_<random>"
  name          TEXT NOT NULL,                         -- human label
  key_hash      TEXT NOT NULL,                         -- SHA-256 of plaintext key
  key_prefix    TEXT NOT NULL,                         -- first 8 chars of plaintext, for UI display
  scopes        TEXT NOT NULL,                         -- JSON array
  org_id        TEXT,                                  -- optional org binding
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX api_keys_key_hash_idx ON api_keys(key_hash);
CREATE INDEX api_keys_org_id_idx ON api_keys(org_id);
```

**Plaintext key format:** `rak_<random-32-bytes-base64url>`. Prefixed so logs
can identify them; the actual entropy is the random suffix. Returned to the
caller exactly once on `POST /v1/api-keys`; only the hash is persisted.

**Routes:**

- `POST /v1/api-keys` (auth: bearer, scope: `relayauth:api-keys:create`)
  Body: `{ name, scopes[], orgId? }`
  Response: `{ apiKey: { id, name, prefix, scopes, createdAt }, key: "rak_…" }`
  201, key returned exactly once.

- `GET /v1/api-keys` (auth: bearer, scope: `relayauth:api-keys:read`)
  Returns paginated list with `prefix` only — never the plaintext key.

- `POST /v1/api-keys/:id/revoke` (auth: bearer, scope: `relayauth:api-keys:revoke`)
  Sets `revoked_at`, returns the updated record. Idempotent.

**New middleware `apiKeyAuth`:**

Reads `x-api-key` header, hashes, looks up in DB. If found and not revoked,
attaches the api-key record (and its scopes) to the request context.
Updates `last_used_at` (debounced — once per key per minute is fine).

**Updated middleware on `/v1/identities` and `/v1/tokens`:** accept *either*
existing bearer JWT auth *or* `x-api-key`. Bearer-or-apiKey, matching the
contract test that already declares this.

**Tests:**
- API key create → returned key authenticates against `POST /v1/identities`
- Revoked key → 401 on identity create
- Hash isolation: changing one byte of the plaintext fails verification
- API key is never logged in plaintext (audit log scrubber)

### Phase 2 — RS256 signing + JWKS

PR 2 in relayauth.

**Key material:**

- One active signing key per environment, stored as an RSA private key
  PEM in a secret (Cloudflare Worker secret `RELAYAUTH_SIGNING_KEY_PEM`
  for production; local dev uses a fixed dev key for reproducibility,
  same approach as today's HS256 dev secret).
- `kid` derived from key fingerprint, e.g. `production-2026-04-22-<sha8>`.
  Allows multiple keys to coexist during rotation.

**Signing path:**

- New `signRs256(claims, privateKeyPem, kid)` helper using `crypto.subtle`
  (Workers runtime has it; Node entrypoint imports `node:crypto`).
- `POST /v1/tokens` uses this instead of the existing HS256 signer.
- Token header switches to `{"alg":"RS256","typ":"JWT","kid":"production-2026-04-22-<sha8>"}`.

**JWKS path:**

- `GET /.well-known/jwks.json` returns the *public* JWK derived from the
  private key, with `kty:"RSA"`, `n`, `e`, `kid`, `use:"sig"`, `alg:"RS256"`.
- During the dual-accept window (Phase 3), the JWKS still also publishes
  the legacy HS256 metadata so any cached verifier doesn't error before
  it picks up the new RSA entry.

**Tests:**
- A token signed with the new path verifies against the JWKS endpoint via
  `TokenVerifier` from `@relayauth/sdk` (the same code specialist runs).
- `kid` in the header matches a key in JWKS.
- Tampering with the payload → signature verification fails.
- Public JWK has no `d` (private exponent) field.

### Phase 3 — Dual-verify cutover

PR 3 in relayauth (deploy-only / no behavior change without env flag).

The risky step. Token TTL is 1 hour, so any HS256 token issued before the
cutover is dead within an hour. To avoid breaking in-flight verification
during that window, the verifier must accept *both* algorithms briefly.

**Two flag-controlled steps:**

1. **Verifier-first deploy:**
   - Verifier accepts RS256 *or* HS256 (HS256 path keeps using the shared
     secret as today).
   - Signer still produces HS256.
   - Roll forward: every consumer that uses `@relayauth/sdk`'s
     `TokenVerifier` upgrades to a version that supports both algorithms.

2. **Signer cutover:**
   - Set env `RELAYAUTH_SIGNING_ALG=RS256`.
   - `POST /v1/tokens` now signs RS256.
   - Existing HS256 tokens continue to verify until they expire.
   - JWKS publishes the RSA key.

3. **HS256 sunset (after TTL window):**
   - Remove HS256 from verifier accept list.
   - Drop legacy HS256 entry from JWKS.

The flag lets us roll the signer change forward then back if anything
breaks within the first hour, without leaving the system in a state where
one party signs differently than the other expects.

### Phase 4 — Bootstrap admin + sage API key

Operational, one human action.

- Generate (or reuse) an admin bearer JWT with `relayauth:api-keys:create`
  scope. The dev path in `scripts/generate-dev-token.sh` already exists;
  add a production variant that signs with the new RSA private key and
  the admin identity.
- Use that JWT once: `curl -X POST https://api.relayauth.dev/v1/api-keys
  -H "Authorization: Bearer <admin>" -d '{"name":"sage-specialist-caller",
  "scopes":["specialist:invoke"]}'`. Save the returned `key`.
- Add to GitHub Actions repo secrets as `SAGE_RELAYAUTH_API_KEY`. From
  this point, sage PR #97 + cloud PR #280 chain through automatically.

### Phase 5 — Sage / cloud rollout

Existing PRs:

- [sage #97](https://github.com/AgentWorkforce/sage/pull/97) — already correct shape; merges cleanly once API keys are issuable.
- [cloud #280](https://github.com/AgentWorkforce/cloud/pull/280) — already correct shape; deploy succeeds once `SAGE_RELAYAUTH_API_KEY` GitHub secret is set.

Order: sage release → bump-sage-worker workflow → cloud deploy. Then verify
specialist tools work end-to-end.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Verifier upgrade lag — a verifier still on the old SDK can't read RS256 tokens | Phase 3 step 1 ships verifier-side first, signer cuts over only after every consumer is on the dual-accept SDK |
| Private key compromise | RSA private key never leaves the worker secret store; rotation-friendly `kid` scheme means we can issue a new key without touching consumers |
| `apiKey` storage compromise | Plaintext key is hashed (SHA-256) before persistence; only the hash + 8-char prefix is kept. Compromised DB cannot recover keys |
| Admin bearer token bootstrap is manual | Document it once in `docs/admin-bootstrap.md`; future creation flows through the API key surface |
| Existing HS256 in-flight tokens during cutover | 1-hour TTL + dual-accept window in Phase 3 |
| RelayAuth deploy path is unclear | Phase 0: spec out + ship a deploy workflow before cutover. (Out of scope here but called out below.) |

## Open questions for the spec review

1. **Where is the production RSA key actually generated?** Options: human runs `openssl genrsa -out private.pem 4096` and `wrangler secret put RELAYAUTH_SIGNING_KEY_PEM`, or workers code generates on first boot and writes to KV. The first is auditable; the second is closer to "self-bootstrapping".
2. **Should `POST /v1/api-keys` itself accept `x-api-key` auth (so an existing key can mint a downstream key)?** Spec currently says bearer-only to keep the bootstrap chain explicit. Easy to relax later.
3. **Audit:** every token mint and every API key use should land in `audit_logs`. The schema already supports this; just need to wire the new endpoints in.
4. **Production deploy path:** the relayauth repo has no CD workflow today. Specifying that is out of scope here but is a hard prerequisite for landing this safely. A separate spec issue should track it.

## Out of scope (followups)

- RelayAuth production CD pipeline (currently manual).
- Customer-facing rate limits on API key creation.
- API key UI in the relayauth landing/admin dashboard.
- Multi-issuer / per-tenant signing keys.
- Service-to-service mTLS as an alternative to API keys.

## Acceptance criteria

This spec is complete when:

- [ ] All four phases land as separate, reviewable PRs with the migration order respected.
- [ ] `https://api.relayauth.dev/.well-known/jwks.json` returns an RS256 JWK with `kty:"RSA"`, `n`, `e`, `kid`.
- [ ] A token issued by `POST /v1/tokens` against production verifies cleanly via `@relayauth/sdk`'s `TokenVerifier` with no code changes on the verifier side.
- [ ] Sage's harness, after sage 1.4.x release with PR #97 + cloud deploy with PR #280, calls specialist `/a2a/rpc` successfully and returns real GitHub data in Slack.
- [ ] No `[slack-runner] incomplete harness outcome { stopReason: 'max_iterations_reached' }` in sage CloudWatch for at least 1 hour after rollout.
