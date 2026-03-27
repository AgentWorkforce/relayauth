# Work on the Relay — Implementation Summary

## 1. What Was Built

### relayauth (this repo)

| File | Purpose |
|------|---------|
| `scripts/relay/relay.sh` | CLI orchestrator — `relay init/up/down/provision/shell/token/mount/status` |
| `scripts/relay/install.sh` | Symlinks `relay` into `/usr/local/bin` |
| `scripts/relay/parse-config.ts` | Parses & validates `relay.yaml` (scopes, ACLs, roles) |
| `scripts/relay/seed-acl.ts` | Seeds `.relayfile.acl` markers into relayfile's VFS |
| `scripts/relay/e2e-test.sh` | End-to-end permission-enforcement tests (6 scenarios) |
| `packages/types/src/token.ts` | Added `workspace_id` and `agent_name` optional claims |
| `packages/server/src/__tests__/test-helpers.ts` | Test token generator updated with new claims |
| `scripts/generate-dev-token.sh` | Emits dual claims (`wks`/`workspace_id`, `agent_name`) + `aud: ["relayauth","relayfile"]` |
| `docs/auth-changes-plan.md` | Design doc for JWT claim mapping (Option A chosen) |
| `docs/relay-integration-review.md` | Post-implementation review — all 6 criteria pass |

### relayfile (companion repo)

No code changes required. relayauth emits relayfile-compatible JWTs (Option A: dual claims), so relayfile works as-is.

---

## 2. How to Use It

### Prerequisites
- Node.js + npm (for relayauth)
- Go 1.21+ (for relayfile)
- Both repos cloned side-by-side

### Step-by-step

```bash
# 1. Place relay.yaml in your project root
cat > relay.yaml <<'EOF'
version: "1"
workspace: my-project
signing_secret: dev-relay-secret

agents:
  - name: agent-1
    scopes:
      - relayfile:fs:read:/src/*
      - relayfile:fs:write:/src/api/*
  - name: agent-2
    scopes:
      - relayfile:fs:read:*

acl:
  /src/secrets/:
    - deny:agent:agent-2
EOF

# 2. Install the relay CLI (one-time)
source scripts/relay/relay.sh
# Or: bash scripts/relay/install.sh  →  adds `relay` to PATH

# 3. Start both services
relay up
# Starts relayauth on :8787, relayfile on :8080
# Waits for health checks before returning

# 4. Provision identities & tokens
relay provision
# Creates identities in relayauth for each agent in relay.yaml
# Issues scoped JWTs, stores in .relay/tokens/<name>.jwt
# Seeds ACL markers into relayfile

# 5. Enter a scoped agent shell
relay shell agent-1
# Exports RELAYFILE_TOKEN and RELAYFILE_BASE_URL
# Opens a new shell where all relayfile operations
# are scoped to agent-1's permissions

# 6. Use relayfile — permissions are enforced
curl -H "Authorization: Bearer $RELAYFILE_TOKEN" \
  http://127.0.0.1:8080/v1/workspaces/my-project/fs/file?path=/src/hello.ts
# 200 OK — agent-1 has read scope on /src/*

curl -X PUT -H "Authorization: Bearer $RELAYFILE_TOKEN" \
  http://127.0.0.1:8080/v1/workspaces/my-project/fs/file?path=/src/secrets/key.pem \
  -d "data"
# 403 Forbidden — ACL denies this path

# 7. Tear down
relay down
# Stops both services gracefully
```

---

## 3. Architecture

```
relay.yaml
    │
    ▼
┌──────────────────┐
│  parse-config.ts │──validates scopes against canonical parser
└────────┬─────────┘
         │ JSON config
         ▼
┌──────────────────┐        ┌─────────────────┐
│    relay.sh      │──up──▶ │  relayauth:8787  │  (identity + JWT)
│   (orchestrator) │──up──▶ │  relayfile:8080  │  (virtual FS)
│                  │        └────────┬─────────┘
│                  │                 │ shared SIGNING_KEY
│   provision ─────┼─────────────────┘
│     │            │
│     ├─ POST /v1/identities  (create agent identity)
│     ├─ POST /v1/tokens      (issue scoped JWT)
│     │   JWT contains:
│     │     sub: agent-1
│     │     workspace_id: my-project
│     │     agent_name: agent-1
│     │     scopes: [relayfile:fs:read:/src/*]
│     │     aud: [relayauth, relayfile]
│     │
│     └─ seed-acl.ts → PUT .relayfile.acl markers
│
│   shell agent-1 ──▶ exports RELAYFILE_TOKEN
│                     agent uses relayfile API
│                     relayfile validates JWT scopes
│                     + checks .relayfile.acl markers
└──────────────────┘
```

**JWT flow**: relayauth issues a JWT with scopes from `relay.yaml`. The token includes `aud: ["relayauth","relayfile"]` so relayfile accepts it. relayfile validates the JWT signature (shared secret), checks the scope claims against the requested operation, and checks ACL marker files for path-level deny rules.

---

## 4. Next Steps (Post-MVP)

From the spec and review, these items remain:

| Item | Priority | Description |
|------|----------|-------------|
| `.relay/` in `.gitignore` | High | Prevent accidental token commits |
| Portable paths | Medium | Replace hardcoded `/Users/khaliqgant/...` in `relay.sh` and `install.sh` with `$(dirname "$0")` derivation |
| Auto-provision on `relay up` | Medium | Spec calls for `relay up` to automatically run `relay provision` |
| `relay mount` integration | Low | FUSE mount via relayfile-mount binary |
| Roles support in provisioning | Low | `parse-config.ts` parses roles; `relay provision` doesn't yet expand them |
| Production signing keys | Future | Replace shared symmetric secret with asymmetric keys / JWKS |
| Rate limiting & budgets | Future | Token budget claims are defined but not enforced |
