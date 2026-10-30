# Self-hosting RelayAuth

RelayAuth's Node server (`packages/server`) runs as one process over a single
SQLite file. This page covers the container image, the Helm chart, the
configuration surface, and the signing-key rotation runbook.

## Configuration

Every secret-bearing variable also accepts a `<NAME>_FILE` variant that points
at a mounted file (Docker/Kubernetes secrets). A directly set variable wins over
its `_FILE` variant. `_FILE` handling lives only in the Node entrypoint
(`startServer`); `createApp()` stays runtime-neutral.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | no | Listen port (image default `8787`). |
| `RELAYAUTH_DB_PATH` | no | SQLite path (image default `/data/relayauth.db`, on the `/data` volume). |
| `BASE_URL` | yes | Public URL of this server; used for discovery and the JWKS URL. |
| `RELAYAUTH_ISSUER` | recommended | `iss` stamped on every token RelayAuth mints and required on tokens it verifies; also advertised as `issuer` in `/.well-known/agent-configuration` and used as the sponsor-grant issuer. When set it is also enforced on bearer tokens presented to RelayAuth itself. Image default when unset: `https://relayauth.dev` (hosted back-compat; discovery then advertises the request origin and sponsor grants use `BASE_URL`, so set it for self-host). The Helm chart always sets it (default: `baseUrl`). Verifiers (History, the control plane) must pin the same value. |
| `INTERNAL_SECRET` / `_FILE` | yes | Internal shared secret. |
| `RELAYAUTH_SIGNING_KEY_PEM` / `_FILE` | yes | **Current** signing key, unencrypted PKCS#8 RSA private key (`BEGIN PRIVATE KEY`; 3072-bit recommended, 2048 minimum). Signs every token; its public half (and `kid`) is always derived from it. PKCS#1 (`BEGIN RSA PRIVATE KEY`) and encrypted keys are refused at boot with a conversion hint. |
| `RELAYAUTH_SIGNING_KEY_PEM_PUBLIC` / `_FILE` | no | Optional cross-check: SPKI public half of the current key. If it does not match the private key, RelayAuth refuses to start (a stale value after a rotation would otherwise advertise the wrong `kid`). Leave it unset. |
| `RELAYAUTH_SIGNING_KEY_PEM_NEXT` / `_FILE` | no | **Next** key (PKCS#8 private or SPKI public PEM). Published in the JWKS, never signs. |
| `RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS` / `_FILE` | no | **Previous** key (PKCS#8 private or SPKI public PEM). Published in the JWKS, never signs. |
| `RELAYAUTH_BOOTSTRAP_API_KEY` / `_FILE` | no | Raw API key to seed at boot with scope `relayauth:assertion:create:relayhistory` (see below). |
| `RELAYAUTH_BOOTSTRAP_API_KEY_ORG` | no | Org for a newly created bootstrap key (default `org_selfhost`). An existing key is never moved; a warning is logged if its org differs. |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS allowlist. |
| `RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN` | no | Exactly `true` lets History assertions bind to a plain-`http` `historyOrigin` on a private host (see below). Any other value, or unset, keeps the hosted rule. Chart: `relayhistory.allowPrivateHttpOrigin`. |
| `RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS` | no | Default-off kill switch. Exactly `true` enables migration-grant creation and assertion minting. Revocation remains available when disabled. Chart: `migrationAssertions.enabled`. |

### Keys and `kid`

`/.well-known/jwks.json` publishes every configured key: current, next and
previous, deduplicated. Each `kid` is the RFC 7638 SHA-256 thumbprint of the
public key, so it is stable across restarts and identical whether a slot holds
the private or public PEM. RelayAuth signs only with the current key and
accepts a token signed by any published key, for its own endpoints (refresh,
introspection, bearer auth, sponsor proofs) as well as for external verifiers.

Generate a key:

```sh
(umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out signing-key.pem)
```

### Bootstrap API key

When `RELAYAUTH_BOOTSTRAP_API_KEY_FILE` is set, the server makes sure, at every
boot, that an API key with exactly that value exists with scope
`relayauth:assertion:create:relayhistory`. A control plane can use it to call
`POST /v1/tokens/relayhistory-assertion` (header `x-api-key`).

- Only the SHA-256 hash and display prefix are stored, as for keys minted via
  `POST /v1/api-keys`. The value is never logged; boot logs only the record id.
- The operation is idempotent: if the key already exists the server logs
  `bootstrap api key exists` and changes nothing.
- A **revoked** bootstrap key stays revoked, and a key with the same value but
  different scopes is left as-is. Both cases log a warning. To rotate, write a
  new value into the file and restart. The old key keeps working until you
  revoke it (`POST /v1/api-keys/:apiKeyId/revoke`).
- The value must be a single token of at least 32 characters, for example
  `printf 'rak_%s\n' "$(openssl rand -hex 32)"`.

### History origins over private http

`POST /v1/tokens/relayhistory-assertion` binds each assertion to one History
`historyOrigin` (its `aud`). By default that origin must be `https`, or `http`
only on loopback (`localhost`, `127.0.0.1`, `[::1]`). In-cluster History
usually runs on plain http behind private DNS, so set
`RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true` to also accept `http` when
the host is:

- a private IP literal: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, or
  IPv6 unique-local `fc00::/7`;
- a single-label hostname (`http://history:8080`, an in-namespace Service);
- a hostname ending in `.svc`, `.svc.cluster.local`, `.cluster.local`,
  `.internal` or `.local` (`http://relayhistory.relayhistory.svc:8080`).

Suffixes match whole trailing labels, so `http://history.svc.example.com` and
`http://history.internal.example.com` are public names and stay refused, as are
public IPs (`http://8.8.8.8`), link-local (`169.254/16`, `fe80::/10`), CGNAT
(`100.64/10`), `0.0.0.0` and IPv4-mapped IPv6. The origin must still be bare:
`scheme://host[:port]` with no path, query, fragment, userinfo, percent escapes
or trailing DNS dot; it is canonicalised (lowercase, default port dropped)
before it becomes the `aud`. `https` rules are unchanged. The flag widens only
which http hosts are accepted. It does not make a public http origin acceptable,
so turn it on only where History is reached over a trusted private network.

### Migration assertions

A one-time export (for example, uploading historical sessions to an ingest
API under each original user's identity) must not use the History assertion
key: that key mints for any `orgId` and `sponsorId` named in the request body.
`POST /v1/tokens/migration-assertion` is the narrow alternative. It mints only
under a **migration grant** that an org administrator creates first.

**1. Create a dedicated key.** `POST /v1/api-keys` with
`scopes: ["relayauth:assertion:create:migration"]` and no other scope. A key
that also carries any other scope, a wildcard such as
`relayauth:assertion:create:*`, or a workspace token is refused as the grant's
key.

Keep `RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS` unset until the export window is
approved. Set it to exactly `true` only for grant creation and minting. This is
a capability-specific switch; it does not enable the broader History assertion
endpoint.

**2. Create the grant.** `POST /v1/migration-grants`, scope
`relayauth:api-key:manage:*` (bearer or `x-api-key`):

```json
{
  "apiKeyId": "<the dedicated key's id>",
  "audience": "https://ingest.example.com",
  "plan": {
    "exported_at": "2026-11-01T00:00:00.000Z",
    "manifests": [{
      "key": "v1/ws=ws_a/m=machine-a/h=codex/d=2026/11/01/s=session-a/manifest.json",
      "org_id": "org_a",
      "workspace_id": "ws_a",
      "source_user_id": "user_a",
      "session": {
        "machine_id": "machine-a",
        "harness": "codex",
        "session_id": "session-a",
        "started_at": "2026-11-01T00:00:00.000Z"
      },
      "state": "closed",
      "chunks": [{
        "seq": 0,
        "epoch": 0,
        "start_offset": 0,
        "bytes": 512,
        "sha256": "<64 lowercase hex>",
        "records": 1
      }]
    }]
  },
  "notAfter": "2026-11-05T00:00:00Z"
}
```

- The key must exist in the caller's org and be unrevoked.
- `audience` is a bare `https` origin, canonicalised as for `historyOrigin`.
  Plain `http` is accepted only on a private host and only with
  `RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true`; loopback `http` is not
  accepted without the flag.
- RelayAuth canonicalises one leading `relay_` from org, workspace and source
  user ids, validates each manifest path against its explicit session and
  workspace fields, derives the content hash chain and raw byte count, sorts
  entries by key, then stores the resulting contract-v1 plan. The caller does
  not supply `grantId`, `planDigest`, content hashes or entry hashes.
- The plan contains 1 to 1000 entries, at most 64 distinct source users, and
  its canonical `plan_json` plus `allowed_pairs_json` must total at most
  1,000,000 UTF-8 bytes. The size ceiling is intentionally half D1's
  2,000,000-byte string/row ceiling so the legacy user list and scalar row
  fields retain headroom. The shared #43 contract fixture is 1,695 bytes.
  Each source user requires two alias-safe identity lookups; the 64-user cap
  bounds Cloud creation at 128 identity Durable Object subrequests.
  Its exact distinct
  `(source_user_id, workspace_id)` pairs become the grant allow-list. Every
  source user must be an **active human identity of the caller's org** in
  RelayAuth, or the grant is refused with
  `source_user_not_found`, `source_user_org_mismatch`, `source_user_not_human`
  or `source_user_inactive`.
- `notAfter` is in the future and at most 7 days away.

The response (201) is the grant: `grantId`, `orgId`, `apiKeyId`,
`planDigest`, `audience`, `allowedPairs`, `planEntries`, `notAfter`, `createdBy`,
`createdAt`, `revokedAt` (null). `POST /v1/migration-grants/:grantId/revoke`
(same scope, same org) revokes it; a second revoke is a 409.

**3. Mint.** `POST /v1/tokens/migration-assertion` with header `x-api-key` set
to the dedicated key (a bearer token carrying the scope is refused):

```json
{
  "grantId": "mgr_...",
  "sourceUserId": "user_a",
  "workspaceId": "ws_a",
  "upload": {
    "key": "v1/ws=ws_a/m=machine-a/h=codex/d=2026/11/01/s=session-a/manifest.json"
  },
  "nonce": "16-128 chars of A-Za-z0-9_-",
  "expiresIn": 60
}
```

The grant must belong to the key's org and name this key, be unrevoked and
before `notAfter`, and list `sourceUserId`, which must still be an active human
identity of the grant's org. The exact source-user/workspace pair and upload
key must occur together in the stored plan; a caller cannot cross pairs or
choose a fresh machine, session, manifest or workspace. The request carries
only the manifest key and cannot override a digest or signed identity.
`expiresIn` is 1 to 60 seconds (default 60), and
`exp` never passes the grant's `notAfter`. The response (201) is
`{ accessToken, accessTokenExpiresAt, tokenType: "Bearer" }`, with no refresh
token. The token's claims are `sub: agent_relayhistory_migration`, `org` = the
grant's org, `wks` = `workspaceId`, `sponsorId` = `sourceUserId`,
`sponsorChain: [sourceUserId, sub]`, `scopes: ["rth:sync"]`,
`aud: [grant audience]`, `token_type: access`, `jti`, `sid`, and `meta` with
`tokenClass: "migration_assertion"`, `grantId`, `planDigest`, `nonce`,
`sourceUserId`, `actorId`, `actorOrgId`, `workspaceId`, and an issuer-derived
`upload` object. `meta.upload` binds `grant_id`, `plan_digest`, `key`, `org_id`,
`workspace_id`, `source_user_id`, the machine/harness/session/start tuple,
`content_sha256`, and the canonical plan-entry `entry_sha256`. The issuer never
echoes a client-authored upload identity.

Grant creation, revocation and every mint are written to the audit log with
the record they produce: `migration_grant.created`, `migration_grant.revoked`,
and `token.issued` on resource `migration-assertion`. Every refusal after the
caller authenticates is also audited, with `result: denied` and the refusal
code, in the caller's org.

#### Threat model

- **What RelayAuth guarantees.** Only the one key a grant names can mint under
  it; never for another org; only for exact user/workspace/upload-key tuples in
  the stored canonical plan whose user is, at mint time, an active human
  identity of the grant's org; only for the grant's one
  audience, with only `rth:sync`, for at most 60 seconds and never past the
  grant's deadline. A History verifier that checks `aud` refuses a migration
  assertion, and neither assertion key can call the other endpoint.
- **Fail closed on users.** A user RelayAuth has no identity for cannot be
  migrated: there is no fallback to the allow-list alone. Retiring,
  suspending or deleting the identity after the grant stops further mints for
  that user. Users that exist only in Cloud must be created as RelayAuth human
  identities before they can be listed.
- **Replay is the verifier's job.** RelayAuth does not record `jti` or `nonce`
  consumption. The ingest service must accept each `jti` (and `nonce`) once,
  check `aud`, `exp`, `iss` and the signature, and must check `meta.upload`
  against the expected plan entry and digest.
- **Revocation.** Revoking a grant or its key stops new mints. Assertions
  already issued stay valid until they expire. Grant revocation is checked on
  every mint, so its convergence window is the assertion TTL: at most 60
  seconds. **Key-only revocation is not a sufficient emergency control in the
  Cloud runtime:** a settled key lookup may remain cached for 60 seconds and a
  final assertion may then live another 60 seconds, for a worst-case 120-second
  window. Revoke the grant as the primary control and revoke the key as defense
  in depth.
- **Kill switch/runbook.** Before ending the export, revoke every grant, revoke
  its dedicated key, wait at least 60 seconds from successful grant revocation,
  then disable `RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS`. In Cloud this flag is a
  Worker binding, so disabling it requires a verified binding deploy; changing
  a local shell value does not affect a deployed Worker. In Helm it likewise
  requires a successful workload rollout. If compromise is suspected, deploy
  the disabled binding and revoke grants immediately, then revoke keys. Grant
  revocation intentionally remains callable while the flag is off. Assertions
  never have refresh tokens.
- **Workspace membership remains an operator/verifier trust boundary.**
  RelayAuth binds the exact source-user/workspace pair approved in the plan and
  proves that the source user is an active human in the organization. It does
  not independently query Cloud or another product for current workspace
  membership. The grant administrator must review that association, and the
  ingest verifier must enforce authoritative workspace membership if its
  policy requires it.
- **Verifier rollout surface.** The TypeScript SDK validates the exact nested
  `meta.upload` shape. The general core and Go verifiers are not expanded by
  this migration-only change. That is nonblocking for the dedicated Cloud
  ingest path, which performs its own migration capability checks, but another
  consumer must not admit migration assertions until it implements the same
  audience, scope, upload-identity, digest and one-time-use checks.
- **Disclosure.** The refusal codes distinguish an unknown user from one in
  another org, so a grant administrator can learn whether an identity id
  exists elsewhere. Identity ids are random and the caller already needs the
  org's api-key management scope.

## Docker

Release images are published for Linux amd64 and arm64 at
`ghcr.io/agentworkforce/relayauth`. Production deployments should use the
immutable manifest digest reported by the container release workflow:

```sh
docker pull ghcr.io/agentworkforce/relayauth@sha256:<manifest-digest>
```

Version and `latest` tags are discovery conveniences only; the standalone Helm
chart requires a digest so a later tag update cannot change deployed code.
The package must be public in its GitHub package settings; the release workflow
removes its registry credentials and verifies an anonymous digest pull before it
reports success. GitHub creates a new container package as private, so an
organization owner must make the package public after the first push and rerun
the initially failing workflow once.

```sh
docker build -f docker/Dockerfile -t relayauth:local .
docker run -d --name relayauth -p 127.0.0.1:8787:8787 \
  -v relayauth-data:/data -v "$PWD/secrets:/run/secrets:ro" \
  -e BASE_URL=http://127.0.0.1:8787 -e RELAYAUTH_ISSUER=http://127.0.0.1:8787 \
  -e INTERNAL_SECRET_FILE=/run/secrets/internal-secret \
  -e RELAYAUTH_SIGNING_KEY_PEM_FILE=/run/secrets/signing-key.pem \
  -e RELAYAUTH_BOOTSTRAP_API_KEY_FILE=/run/secrets/bootstrap-api-key \
  relayauth:local
```

The image is multi-stage, runs as the unprivileged `node` user (uid 1000),
declares `VOLUME /data`, and has a `HEALTHCHECK` on `/health`. Mounted secret
files must be readable by the container user. If you pass `--user`, the `/data`
mount must be writable by that uid.

`scripts/selfhost-smoke.sh` builds the image and runs an end-to-end check on
`127.0.0.1:19380` with throwaway keys: it seeds the bootstrap key, mints a
History assertion, verifies it against the JWKS, rotates, and checks that old
tokens still verify while new tokens carry the new `kid`. It also checks that an
assertion for `http://history.relayhistory.svc:8080` is refused with the flag
off and minted with `RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true`.

## Helm

`charts/relayauth` deploys exactly one replica with the `Recreate` strategy, a
`ReadWriteOnce` PVC for `/data` (kept on uninstall), a ClusterIP Service, and
liveness/readiness probes on `/health`. The chart never renders secrets. Create
the Secret yourself and point `existingSecret` at it:

```sh
kubectl create secret generic relayauth \
  --from-file=internal-secret=./internal-secret \
  --from-file=signing-key.pem=./signing-key.pem \
  --from-file=bootstrap-api-key=./bootstrap-api-key
helm install relayauth charts/relayauth \
  --set baseUrl=https://auth.example.internal
```

`baseUrl` defaults to this release's in-cluster Service,
`http://<fullname>.<namespace>.svc:<service.port>` (release `relayauth` in
namespace `auth` gives `http://relayauth.auth.svc:8787`; release `myrel` gives
`http://myrel-relayauth.auth.svc:8787`), so the advertised JWKS URL resolves for
any release name. Set it explicitly when verifiers reach RelayAuth through
another name (ingress, external DNS); because it is also the default issuer,
changing it later invalidates tokens for verifiers pinned to the old value.

`issuer` defaults to `baseUrl`, and the chart always sets `RELAYAUTH_ISSUER`,
so minted tokens, `/.well-known/agent-configuration` and sponsor grants carry
the same issuer. Override `issuer` only if verifiers pin a different value.

`secretKeys.*` maps each role to a key name inside the Secret. Leave
`signingKeyNext`, `signingKeyPrevious` or `signingKeyPublic` empty to omit
them, and set `bootstrapApiKey: ""` to skip bootstrap seeding. Set
`relayhistory.allowPrivateHttpOrigin=true` when History is reached over plain
http on in-cluster DNS (see "History origins over private http").

## Signing-key rotation runbook

Keys are read at boot, so every step below ends with a restart
(`kubectl rollout restart deployment/relayauth`, or recreate the container).

Timing inputs:

- **JWKS cache:** the JWKS is served with `Cache-Control: max-age=3600`, and
  the RelayAuth SDK verifier caches it for 5 minutes, refetching on an unknown
  `kid`. Call the longest verifier cache *C* (1 hour if you honour the header).
- **Longest-lived token signed by the old key, *T*:** access tokens default to
  1 hour, refresh tokens to 24 hours (operator-configurable up to 90 days),
  bounded durable read-only tokens up to 90 days, and History assertions at
  most 60 seconds.
- **Indefinite tokens have no *T*.** Durable tokens minted with
  `indefinite: true` carry a fixed `exp` in the year 2100 and no refresh
  token, so waiting never drains them. Every indefinite token signed by A
  stops verifying when A is retired (step 5). Before retiring A, reissue each
  one (it is then signed by B), hand the new token to its holder, and revoke
  the old one; their issuance is flagged `indefinite: "true"` in the
  issued-token audit metadata. RelayAuth does not record which key signed a
  token and does not block step 5, so this is on the operator.

Steps:

1. **Stage the next key.** Generate key B. Add it as
   `RELAYAUTH_SIGNING_KEY_PEM_NEXT` (the private PEM is fine; only its public
   half is published). Restart. `/.well-known/jwks.json` now lists A and B.
   New tokens are still signed with A.
2. **Wait at least *C*** so every verifier has cached a JWKS containing B.
3. **Promote.** Set current = B (`RELAYAUTH_SIGNING_KEY_PEM`). Remove
   `RELAYAUTH_SIGNING_KEY_PEM_PUBLIC` / `secretKeys.signingKeyPublic` (or
   replace it with B's public key in the same change): a stale A public key
   no longer matches the private key and RelayAuth refuses to start rather
   than advertise the wrong `kid`. Previous = A (`RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS`, preferably the
   public PEM only), and clear next. Restart. New tokens carry B's `kid`, and
   tokens signed by A still verify.
4. **Wait at least *T*, and reissue indefinite tokens.** Refresh tokens
   signed by A keep working during this window. Removing A earlier forces
   those sessions to log in again. Reissue every `indefinite: true` token
   signed by A (see above) before going on.
5. **Retire.** Remove `RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS` and restart.
   RelayAuth rejects tokens signed by A at once. External verifiers drop A
   only when their cached JWKS expires: up to 5 minutes for the SDK default,
   up to 1 hour for caches that honour `max-age` (*C*). Archive A's public key if you need
   to verify old sponsor-binding ledger signatures (they record the signing
   `kid`).

Emergency rotation (key compromise): run steps 1 and 3 back to back, skip the
waits, and retire A immediately. RelayAuth itself rejects tokens signed by A
as soon as it restarts, but external verifiers keep accepting them until their
cached JWKS expires. The SDK verifier (`packages/sdk/typescript/src/verify.ts`,
`DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000`) serves its cached keys for 5 minutes
unless `cacheTtlMs` is set, and refetches early only when a token's `kid` is
missing from the cache, so a token signed by A still verifies there until
expiry. Verifiers or proxies that honour the JWKS `Cache-Control:
max-age=3600` can keep A for up to 1 hour. For immediate rejection, restart
(or clear the JWKS cache of) every verifier after retiring A. Clients whose
tokens were signed by A, including indefinite tokens, must re-authenticate or
be reissued tokens.

## Limitations

- Single replica only (SQLite). The chart refuses `replicaCount != 1`.
- `historyOrigin` on History assertions must be `https`, or `http` on a
  loopback host, unless `RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true`
  (private hosts only; see above).
