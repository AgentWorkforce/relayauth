# Work On The Relay — Specification

## Overview

"Work on the relay" is a local sandbox mode that combines **relayauth** (identity +
permissions) with **relayfile** (virtual filesystem) so that agents operate under
granular, scoped file permissions enforced end-to-end using relay primitives.

A developer runs a single shell script that boots both services locally, reads a
`relay.yaml` config file, provisions identities/tokens, and mounts a workspace —
giving agents a sandboxed filesystem where every read/write is permission-checked.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Developer Shell                                      │
│                                                       │
│  $ relay init          ← reads relay.yaml             │
│  $ relay up            ← boots relayauth + relayfile  │
│  $ relay shell agent-1 ← drops into scoped shell      │
│                                                       │
│  ┌─────────────┐    JWT    ┌──────────────┐           │
│  │  relayauth   │◄────────►│  relayfile    │           │
│  │  :8787       │  shared   │  :8080        │           │
│  │              │  secret   │               │           │
│  │  identities  │          │  VFS + ACL    │           │
│  │  scopes      │          │  mount client │           │
│  │  tokens      │          │  .relayfile/  │           │
│  └─────────────┘          └──────────────┘           │
│         │                        │                    │
│         └────────┬───────────────┘                    │
│                  ▼                                    │
│        relay.yaml (permissions config)               │
│        ./workspace/ (mounted files)                  │
└──────────────────────────────────────────────────────┘
```

## Permission Tiers

Two tiers of permission control, designed so most users never need the second:

### Tier 1: Dot files (zero config, .gitignore-style)

Drop dot files in your project. No relay.yaml needed. Works immediately.

```
.agentignore              # Global: files invisible to ALL agents
.{agentId}.agentignore    # Per-agent: files invisible to this agent only
.agentreadonly            # Global: files read-only for ALL agents
.{agentId}.agentreadonly  # Per-agent: files read-only for this agent only
```

**Rules:**
- Patterns use `.gitignore` syntax (globs, negation with `!`, comments with `#`)
- Anything in `.agentignore` → doesn't exist to the agent (no read, no write)
- Anything in `.agentreadonly` → read-only (read yes, write no)
- Everything else → read/write (default open)
- Deny wins: if both ignore and readonly match, ignore wins
- Per-agent files override global: `.code-agent.agentignore` applies only to `code-agent`
- Files cascade: child directory dot files override parent (specificity wins)

**Example:**

```gitignore
# .agentignore — no agent can see these
.env
.env.*
secrets/
credentials/
**/*.pem
**/*.key

# .agentreadonly — agents can read but not modify
README.md
LICENSE
package-lock.json
go.sum
```

```gitignore
# .code-agent.agentignore — code-agent also can't see docs
docs/
```

**Operations control** (beyond just files):
```gitignore
# .agentignore can also restrict operations (future)
# Prefix with ! to denote operations vs file paths
#!git push origin main
#!rm -rf
#!cd ../
#!cd ~
```

### Tier 2: relay.yaml (power users, full scope control)

For users who need granular scopes, RBAC roles, cross-service permissions,
or programmatic provisioning. Tier 1 dot files still apply on top.

## relay.yaml Format

```yaml
# relay.yaml — placed in project root
version: "1"

# Shared config
workspace: my-project
signing_secret: dev-relay-secret  # shared between relayauth + relayfile

# Agents and their permissions
agents:
  - name: agent-1
    scopes:
      - relayfile:fs:read:/src/*
      - relayfile:fs:write:/src/api/*
      - relayfile:fs:read:/docs/*

  - name: agent-2
    scopes:
      - relayfile:fs:read:*          # read everything
      - relayfile:fs:write:/tests/*  # write only to tests

  - name: admin
    scopes:
      - relayfile:fs:read:*
      - relayfile:fs:write:*
      - relayauth:identity:read:*

# Optional: directory-level ACLs (written as .relayfile.acl markers)
acl:
  /src/secrets/:
    - deny:agent:agent-2
    - allow:scope:relayfile:fs:read:/src/secrets/*
  /src/api/:
    - allow:scope:relayfile:fs:write:/src/api/*

# Optional: roles for reuse
roles:
  reader:
    scopes:
      - relayfile:fs:read:*
  backend-dev:
    scopes:
      - relayfile:fs:read:*
      - relayfile:fs:write:/src/*
      - relayfile:fs:write:/tests/*
```

## JWT Claim Mapping

Relayauth and relayfile currently use different JWT claim field names. This must
be reconciled for tokens to work across both services.

| Concept       | relayauth claim | relayfile claim | Resolution                    |
|---------------|-----------------|-----------------|-------------------------------|
| Workspace ID  | `wks`           | `workspace_id`  | relayauth adds `workspace_id` alias |
| Agent name    | (identity name) | `agent_name`    | relayauth adds `agent_name` claim   |
| Scopes        | `scopes`        | `scopes`        | Already aligned               |
| Expiration    | `exp`           | `exp`           | Already aligned               |
| Audience      | `aud`           | `aud`="relayfile" | relayauth includes `relayfile` in aud array |

### Option A: relayauth emits dual claims (recommended)

Add `workspace_id` and `agent_name` to the JWT payload alongside existing claims.
This is backwards-compatible and requires no changes to relayfile.

```typescript
// In relayauth token issuance, add:
payload.workspace_id = payload.wks;
payload.agent_name = identity.name;
```

### Option B: relayfile accepts relayauth claim names

Modify relayfile's `auth.go` to also accept `wks` and look up agent name from `sub`.
More invasive to relayfile.

**Recommendation: Option A** — two lines in relayauth, zero changes in relayfile.

## Shell Script: `relay`

A single CLI entry point added to the shell (e.g., via `source relay-env.sh` or
installed to PATH).

### Commands

```bash
relay init                    # Parse relay.yaml, validate config
relay up                      # Start relayauth (wrangler dev) + relayfile (go run)
relay down                    # Stop both services
relay provision               # Create identities + issue tokens from relay.yaml
relay shell <agent-name>      # Open shell with RELAYFILE_TOKEN set for that agent
relay token <agent-name>      # Print bearer token for an agent
relay status                  # Show running services + agent status
relay mount <agent-name> <dir> # Mount workspace scoped to agent's permissions
```

### `relay up` Flow

1. Parse `relay.yaml`
2. Export `SIGNING_KEY=<signing_secret>` (shared between both services)
3. Start relayauth: `cd ../relayauth && wrangler dev --port 8787 &`
4. Start relayfile: `cd ../relayfile && RELAYFILE_JWT_SECRET=<signing_secret> RELAYFILE_BACKEND_PROFILE=durable-local go run ./cmd/relayfile &`
5. Wait for health checks on both ports
6. Run `relay provision`

### `relay provision` Flow

1. For each agent in `relay.yaml`:
   a. POST to relayauth `/v1/identities` to create identity
   b. POST to relayauth `/v1/tokens` to issue token with specified scopes
   c. Store token locally in `.relay/tokens/<agent-name>.jwt`
2. For each ACL entry in `relay.yaml`:
   a. PUT to relayfile to create `.relayfile.acl` marker files with permissions
3. Print summary of provisioned agents

### `relay shell <agent>` Flow

1. Read token from `.relay/tokens/<agent>.jwt`
2. Export `RELAYFILE_TOKEN=<token>`
3. Export `RELAYFILE_BASE_URL=http://127.0.0.1:8080`
4. Export `RELAYFILE_WORKSPACE=<workspace>`
5. Launch `$SHELL` with these env vars
6. Agent can now use `relayfile` CLI or SDK — all ops permission-checked

## What's Already Working

| Component                           | Status | Notes                                    |
|-------------------------------------|--------|------------------------------------------|
| relayauth token issuance (HS256)    | Done   | POST /v1/tokens                          |
| relayauth scope format              | Done   | `relayfile:fs:read:/path/*` supported    |
| relayauth RBAC roles                | Done   | Can bundle scopes into roles             |
| relayauth identity management       | Done   | Full CRUD                                |
| relayfile JWT validation            | Done   | HS256 with scope checking                |
| relayfile ACL enforcement           | Done   | `.relayfile.acl` markers, ancestor walk  |
| relayfile local backend             | Done   | `durable-local` profile stores to disk   |
| relayfile mount client              | Done   | Polling-based local FS mirror            |
| relayfile CLI                       | Done   | login, workspace, mount, seed, export    |
| Scope format alignment              | Done   | Both repos use same scope syntax         |
| ACL rule format                     | Done   | `scope:X`, `agent:X`, `deny:X` rules    |

## What Needs to Be Built

### Must-have (MVP)

1. **JWT claim mapping** (relayauth, ~30 min)
   - Add `workspace_id` and `agent_name` to token payload
   - Include `relayfile` in the `aud` array
   - ~2 lines in token issuance code

2. **`relay.yaml` parser** (~2 hours)
   - Simple YAML parser (Node or Go)
   - Validate scope format, agent names, ACL rules
   - Output structured config for provisioning

3. **`relay` shell script** (~3 hours)
   - `relay up` / `relay down` — process management
   - `relay provision` — HTTP calls to relayauth API
   - `relay shell <agent>` — token injection into shell
   - `relay token <agent>` — print token

4. **ACL seeding from relay.yaml** (~1 hour)
   - Convert `acl:` entries to `.relayfile.acl` marker files
   - PUT via relayfile API during provisioning

### Nice-to-have (post-MVP)

- `relay watch` — live reload on relay.yaml changes
- `relay logs` — unified log stream from both services
- `relay test` — run a command as an agent and assert permission outcomes
- Token refresh automation
- Docker Compose alternative to process management
- Integration with relaycast for agent-to-agent messaging in sandbox

## Local Testing Checklist

Steps to validate "work on the relay" end-to-end:

```bash
# 1. Add workspace_id + agent_name claims to relayauth tokens
# 2. Start both services with shared secret
export SHARED_SECRET=dev-relay-secret

# Terminal 1: relayauth
cd relayauth
SIGNING_KEY=$SHARED_SECRET wrangler dev --port 8787

# Terminal 2: relayfile
cd relayfile
RELAYFILE_JWT_SECRET=$SHARED_SECRET \
RELAYFILE_BACKEND_PROFILE=durable-local \
go run ./cmd/relayfile

# Terminal 3: test flow
# Create identity in relayauth
curl -X POST http://localhost:8787/v1/identities \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-1","type":"agent","orgId":"org_dev","workspaceId":"ws_dev"}'

# Issue token with relayfile scopes
curl -X POST http://localhost:8787/v1/tokens \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"identityId":"<id>","scopes":["relayfile:fs:read:/src/*","relayfile:fs:write:/src/api/*"]}'

# Use that token against relayfile
export TOKEN=<access_token>
curl http://localhost:8080/v1/workspaces/ws_dev/fs/tree \
  -H "Authorization: Bearer $TOKEN"

# Write to allowed path — should succeed
curl -X PUT http://localhost:8080/v1/workspaces/ws_dev/fs/file?path=/src/api/handler.ts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"// new handler","encoding":"utf-8"}'

# Write to disallowed path — should fail with 403
curl -X PUT http://localhost:8080/v1/workspaces/ws_dev/fs/file?path=/secrets/key.pem \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"secret","encoding":"utf-8"}'
```

## File Layout

```
relay/                          # new repo or shared scripts location
├── relay                       # main CLI script (bash or Go)
├── relay.yaml                  # user's permission config
├── .relay/
│   ├── tokens/
│   │   ├── agent-1.jwt
│   │   └── agent-2.jwt
│   └── config.json             # parsed relay.yaml cache
└── workspace/                  # mounted relayfile workspace
    ├── src/
    │   └── api/
    └── docs/
```
