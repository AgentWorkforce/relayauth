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
| `RELAYAUTH_ISSUER` | recommended | `iss` stamped on every token RelayAuth mints and required on tokens it verifies; also advertised as `issuer` in `/.well-known/agent-configuration` and used as the sponsor-grant issuer. Default `https://relayauth.dev` (back-compat). Verifiers (History, the control plane) must pin the same value. |
| `INTERNAL_SECRET` / `_FILE` | yes | Internal shared secret. |
| `RELAYAUTH_SIGNING_KEY_PEM` / `_FILE` | yes | **Current** signing key, PKCS#8 RSA private key (3072-bit recommended, 2048 minimum). Signs every token. |
| `RELAYAUTH_SIGNING_KEY_PEM_PUBLIC` / `_FILE` | no | SPKI public half of the current key. Derived from the private key when unset. |
| `RELAYAUTH_SIGNING_KEY_PEM_NEXT` / `_FILE` | no | **Next** key (private or public PEM). Published in the JWKS, never signs. |
| `RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS` / `_FILE` | no | **Previous** key (private or public PEM). Published in the JWKS, never signs. |
| `RELAYAUTH_BOOTSTRAP_API_KEY` / `_FILE` | no | Raw API key to seed at boot with scope `relayauth:assertion:create:relayhistory` (see below). |
| `RELAYAUTH_BOOTSTRAP_API_KEY_ORG` | no | Org for a newly created bootstrap key (default `org_selfhost`). |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS allowlist. |
| `RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN` | no | Exactly `true` lets History assertions bind to a plain-`http` `historyOrigin` on a private host (see below). Any other value, or unset, keeps the hosted rule. Chart: `relayhistory.allowPrivateHttpOrigin`. |

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

## Docker

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
  --set baseUrl=https://auth.example.internal \
  --set issuer=https://auth.example.internal
```

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
  durable read-only tokens up to 90 days, and History assertions at most 60
  seconds.

Steps:

1. **Stage the next key.** Generate key B. Add it as
   `RELAYAUTH_SIGNING_KEY_PEM_NEXT` (the private PEM is fine; only its public
   half is published). Restart. `/.well-known/jwks.json` now lists A and B.
   New tokens are still signed with A.
2. **Wait at least *C*** so every verifier has cached a JWKS containing B.
3. **Promote.** Set current = B (`RELAYAUTH_SIGNING_KEY_PEM`; update or remove
   `_PUBLIC`), previous = A (`RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS`, preferably the
   public PEM only), and clear next. Restart. New tokens carry B's `kid`, and
   tokens signed by A still verify.
4. **Wait at least *T*.** Refresh tokens signed by A keep working during this
   window. Removing A earlier forces those sessions to log in again.
5. **Retire.** Remove `RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS` and restart. Tokens
   signed by A are now rejected everywhere. Archive A's public key if you need
   to verify old sponsor-binding ledger signatures (they record the signing
   `kid`).

Emergency rotation (key compromise): run steps 1 and 3 back to back, skip the
waits, and retire A immediately. All tokens signed by A become invalid, so
clients must re-authenticate.

## Limitations

- Single replica only (SQLite). The chart refuses `replicaCount != 1`.
- `historyOrigin` on History assertions must be `https`, or `http` on a
  loopback host, unless `RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true`
  (private hosts only; see above).
