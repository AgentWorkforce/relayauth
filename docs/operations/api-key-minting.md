# API key minting & rotation

How to provision and rotate `@relayauth/server` api-keys for service callers
(sage, specialist-worker, future agents). Use `scripts/mint-api-key.sh`
rather than hand-rolling curl — the script wraps three things that have
bitten operators before:

1. Minting the admin bearer (HS256, signed locally) with the right shape
2. Calling `POST /v1/api-keys` with a body the server will accept
3. Storing the returned key value in a secret store **without** echoing it
   into terminal/shell history

## Quick start: rotate sage's relayfile-minter api-key

This is the canonical example because it's what triggered the script's
existence (incident on 2026-04-23 — sage's api-key had `cloud:specialist:invoke`
which is the wrong scope set entirely).

```bash
./scripts/mint-api-key.sh \
  --name sage-relayfile-minter \
  --scopes-json '[
    "relayauth:identity:manage:*",
    "relayauth:token:create:*",
    "relayfile:fs:read:*",
    "relayfile:fs:write:*"
  ]' \
  --to-gh-secret AgentWorkforce/cloud:SAGE_RELAYAUTH_API_KEY \
  --revoke-prior <previous-api-key-id>
```

The script prints the new api-key id + scopes (safe to share/log), pipes
the key value directly into `gh secret set` (never visible to the
operator), and revokes the previous key after the new one is in place.
Then trigger a cloud deploy so the sage worker picks up the new
`SAGE_RELAYAUTH_API_KEY` value:

```bash
gh workflow run deploy.yml --repo AgentWorkforce/cloud --ref main
```

## Required scopes by service

Each service caller has different needs. Don't copy-paste from the wrong
example — the server enforces per-route scope requirements; an api-key
with the wrong set succeeds at mint but fails at runtime with
`insufficient_scope`, which is a hard 403 from the route handler.

### sage (Slack DM handler → mints relayfile tokens for itself)

`packages/sage/src/integrations/relayfile-jwt.ts` calls:

- `POST /v1/identities` to spawn a child identity per workspace
- `POST /v1/tokens` to mint an access token for that identity, scoped to
  relayfile read/write

So sage's api-key needs:

```json
[
  "relayauth:identity:manage:*",
  "relayauth:token:create:*",
  "relayfile:fs:read:*",
  "relayfile:fs:write:*"
]
```

Note: `POST /v1/identities` requires `relayauth:identity:manage:*`, not
`create:*`. The scope matcher treats `manage` as implying
`create/read/write/delete` (one-way). An api-key with only `create:*`
gets 403 insufficient_scope on the route that demands `manage:*`. The
same check-the-route pattern applies to every other scope string you're
tempted to pick: grep `authenticateAndAuthorizeFromContext` /
`authenticateBearerOrApiKeyAndAuthorize` in the route handler you
intend to call, and match that exact scope string (or a broader
superset).

The relayfile scopes are required because the new identity sage creates
inherits its own scopes from its sponsor's scope set (the api-key's
synthesized claims). Without `relayfile:fs:*`, the minted token would
have no fs permissions even though sage successfully created the identity.

### specialist-worker (verifies sage's bearer; doesn't itself mint)

Specialist-worker only **verifies** incoming bearer tokens via
`@relayauth/sdk`'s `TokenVerifier`. It does not call `/v1/api-keys` or
`/v1/tokens`. It does not need an api-key.

What specialist-worker needs is the JWKS to be reachable (production:
`https://api.relayauth.dev/.well-known/jwks.json`) and, post-phase-122
sunset, the env binding `RELAYAUTH_VERIFIER_ACCEPT_HS256=false`.

### Operator emergency admin api-key

Worth provisioning one before phase 122 step 3 sunsets HS256 admin bearers
so you have a way to make admin calls (rotate keys, revoke compromised
identities, etc.) without an HS256-signed dev token. Stash the value
somewhere outside this repo (1Password, a `~/.relayauth-admin-key` file
with mode 600).

```bash
./scripts/mint-api-key.sh \
  --name operator-admin-emergency \
  --scopes-json '["*:*:*:*"]' \
  --to-file ~/.relayauth-admin-key
```

Then any admin operation, post-sunset:

```bash
curl -sS -X POST https://api.relayauth.dev/v1/api-keys \
  -H "x-api-key: $(cat ~/.relayauth-admin-key)" \
  -H "content-type: application/json" \
  -d '{...}'
```

## How the script protects the secret value

By default, the api-key value never appears in:

- terminal stdout (the script prints id + scopes, not the key)
- shell history (no `echo` or `export`-and-print of the value)
- log files

The supported destinations:

| Flag | Storage | Notes |
|---|---|---|
| `--to-gh-secret REPO:NAME` | GitHub Actions secret | Piped directly into `gh secret set` via stdin. The value is never assigned to a shell variable. Recommended for sage / cloud services. |
| `--to-file PATH` | Local file (mode 600) | For operator emergency keys you need on your laptop. Write to `~/.something`, never to `/tmp` (other processes can read /tmp). |
| `--print-key` | stdout | Only when you're **explicitly** piping to another process. The value will appear in shell history if you run the script directly without piping. |
| (none) | mktemp tempfile, mode 600 | Fallback when the operator forgot to pick a destination. Path is printed to stderr; operator should copy out and `shred -u` immediately. |

## Why scope-subset matters

`POST /v1/api-keys` enforces that the new api-key's `scopes` are a subset
of the *caller's* scopes. The caller is the holder of the admin bearer
that authorizes the mint call. Practical implication:

- The script generates an admin bearer with `["*:*:*:*"]` — wildcard
  superset — so you can mint any narrower scope set.
- An api-key minted with narrower scopes (e.g. only `relayfile:fs:read:*`)
  CANNOT be used to mint a broader api-key. Privilege escalation is
  blocked at this gate.
- If you rotate by issuing a new api-key with the same scopes the old
  one had, no escalation; you're just refreshing the secret value.

## Rotation cadence

Per the spec (`specs/token-format.md`), production keys rotate on a 90-day
cycle. This script doesn't enforce or schedule that — set up a calendar
reminder or a CI job that runs the script with `--revoke-prior` set to
the current key id.

## Recovery: I lost the key value

The api-key value is returned exactly once at creation time. If the
storage step (gh secret set / file write) failed and you didn't capture
the value, you cannot retrieve it. The fix:

1. Revoke the api-key whose value is unknown:
   ```bash
   curl -X POST "$RELAYAUTH_URL/v1/api-keys/<id>/revoke" \
     -H "Authorization: Bearer <admin>"
   ```
2. Re-run the mint with the same `--name` and `--scopes-json` to issue
   a fresh value.

The id is always visible (printed by the script + listed via `GET
/v1/api-keys`); only the value is one-shot.

## Related

- Spec: `specs/api-keys-and-rs256-migration.md` (phase 1)
- Issue documenting the sage scope incident: AgentWorkforce/cloud#287
  (preview/dev) and the comment on cloud#295 (post-cutover verification)
- Source of truth for what scopes each route requires:
  `packages/server/src/routes/*.ts` — search for the third arg to
  `authenticateAndAuthorize` / `authenticateAndAuthorizeFromContext`
