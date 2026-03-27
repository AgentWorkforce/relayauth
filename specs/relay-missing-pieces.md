# Relay Missing Pieces — Specification

## Overview

What remains to complete the "on the relay" system end-to-end, across
local (OSS) and cloud (paid) paths.

---

## 1. Seeding Without External Dependencies

**Status:** relay.sh uses `rsync` (not guaranteed on all systems)
**Target:** Pure TypeScript/Node.js seeding via HTTP

### What exists
- `src/cli/commands/on/workspace.ts` in the relay repo (from sdk-direct-imports workflow)
- `POST /v1/workspaces/{ws}/fs/bulk` endpoint in relayfile

### What needs to happen
- `workspace.ts` walks the project directory using `fs.readdir` recursively
- Skips `.relay/`, `.git/`, `node_modules/`
- Reads each file with `fs.readFile`
- Batches into groups of 50 files
- POSTs each batch to `/v1/workspaces/{ws}/fs/bulk` with Bearer token
- No `rsync`, no `relayfile-cli`, no external binaries
- All Node.js built-ins + `fetch()`

### Verification
- `which rsync` not required
- `agent-relay on codex` works on a machine with only Node.js + Go installed

---

## 2. Workspace System Events Channel

**Status:** Not built. Diagram showed relaycast notifications but no implementation.
**Target:** Structured event stream per workspace for agent coordination + observability.

### Design

Each workspace `rw_a7f3x9k2` gets a system channel: `rw_a7f3x9k2/system`

Events are typed, not chat messages:

```typescript
interface WorkspaceEvent {
  type:
    | "file.created"
    | "file.updated"
    | "file.deleted"
    | "permission.denied"
    | "agent.joined"
    | "agent.left";
  workspaceId: string;
  agent: string;        // which agent triggered the event
  path?: string;        // file path (for file events)
  action?: string;      // "read" | "write" | "delete"
  reason?: string;      // for permission.denied
  timestamp: string;
}
```

### How it works

```
codex writes src/app.ts
  → relayfile accepts write (200)
  → relayfile emits WebSocket event: file.updated
  → mount client on Machine B pulls the new version
  → relaycast system channel: { type: "file.updated", agent: "codex", path: "/src/app.ts" }
  → claude (on Machine B) can subscribe to this channel for awareness

claude tries to write README.md
  → relayfile rejects (403)
  → mount client reverts local file
  → local log: .relay/permissions-denied.log
  → relaycast system channel: { type: "permission.denied", agent: "claude", path: "/README.md", action: "write" }
  → dashboard shows the denial (observability)
```

### Not a DM
- System events are broadcast to the workspace channel, not sent as DMs
- Agents opt-in to listening (subscribe to `rw_xxx/system`)
- Events are structured JSON, not natural language messages
- A dashboard/observer can render them as a timeline

### Noise control
- File events are debounced (batch multiple rapid edits into one event)
- Only permission.denied events are highlighted (they indicate a problem)
- Agents can filter by event type when subscribing

### What needs to happen
1. Relayfile: after accepting/rejecting a write, POST event to relaycast system channel
2. Relaycast: support channel names with `/` (e.g., `rw_a7f3x9k2/system`)
   OR use a convention: channel name = `system-rw_a7f3x9k2`
3. Mount client: on write denial, POST permission.denied event to relaycast
4. `agent-relay on`: subscribe agent to system channel on join
5. Cloud: dashboard renders system events as a timeline

---

## 3. Cloud Relayfile in the Architecture

**Status:** Exists (`cloud/packages/relayfile/`) but not represented in architecture docs.
**Target:** Documented and fully integrated.

### What exists
- Cloudflare Worker with Hono routes
- Durable Objects (WorkspaceDO) for per-workspace state
- D1 for metadata, R2 for file content, KV for counters
- Queues for webhook ingestion + writeback
- Imports `@relayfile/core` and `@relayfile/sdk` from OSS
- CI/CD: `deploy-relayfile.yml` with staging → production

### What's missing
- **Not wired into SST config** — Pulumi infra code exists but isn't called from `sst.config.ts`
- **Secrets not set** — `RelayfileUrl` and `RelayJwtSecret` default to empty
- **No health check in launcher** — launcher doesn't verify relayfile is reachable before spawning sandbox
- **No workspace lifecycle** — workspaces are created implicitly on first write, never cleaned up

### What needs to happen
1. Wire Cloudflare infra into SST deployment
2. Set secrets via `sst secret set RelayfileUrl https://api.relayfile.dev`
3. Add health check in launcher before sandbox creation
4. Add workspace TTL/cleanup (delete workspaces older than 7 days with no activity)

---

## 4. npm Package Publishing

**Status:** Packages exist, publish workflows exist, but nothing published to npm yet.
**Target:** All packages published at 0.1.2, cloud consumes from npm.

### Packages to publish

| Package | Repo | Publish workflow |
|---------|------|-----------------|
| `@relayauth/types` | relayauth | `.github/workflows/publish.yml` |
| `@relayauth/core` | relayauth | `.github/workflows/publish.yml` |
| `@relayauth/sdk` | relayauth | `.github/workflows/publish.yml` |
| `@relayfile/core` | relayfile | `.github/workflows/publish.yml` |
| `@relayfile/sdk` | relayfile | `.github/workflows/publish.yml` |

### Publish order
1. `@relayauth/types` (no deps)
2. `@relayauth/core` (depends on types)
3. `@relayauth/sdk` (depends on core + types)
4. `@relayfile/core` (no relay deps)
5. `@relayfile/sdk` (depends on relayfile/core)

### After publishing
- Cloud: `npm install @relayauth/core@0.1.2 @relayfile/sdk@0.1.2`
- Remove all `file:` references in cloud package.json
- Relay: `npm install @relayauth/core@0.1.2 @relayfile/sdk@0.1.2`

---

## 5. SDK Direct Imports (Remove Shell Subprocesses)

**Status:** Workflow written (`relay/workflows/sdk-direct-imports.ts`), may not have been run.
**Target:** `agent-relay on` uses SDK imports, not `execFileSync('npx', ['tsx', ...])`.

### What needs replacing

| Current (subprocess) | Target (SDK import) |
|---------------------|-------------------|
| `npx tsx dotfile-parser.ts` | `import { parseDotfiles } from './dotfiles.js'` |
| `npx tsx dotfile-compiler.ts` | `import { compileDotfiles } from './dotfiles.js'` |
| `bash generate-dev-token.sh` | `import { mintToken } from './token.js'` |
| `relayfile-cli seed workspace dir` | `import { seedWorkspace } from './workspace.js'` |
| `npx tsx seed-acl.ts` | `import { seedAclRules } from './workspace.js'` |

### What exists (from workflow output)
- `src/cli/commands/on/dotfiles.ts` — parser + compiler using `ignore` npm package
- `src/cli/commands/on/token.ts` — JWT signing with `node:crypto`
- `src/cli/commands/on/workspace.ts` — seed via `fetch()` to relayfile bulk API

### What needs to happen
- Verify all subprocess calls are removed from `start.ts` and `provision.ts`
- Verify `agent-relay on codex` works without `relayauth/scripts/relay/` existing
- The relay CLI should be fully self-contained

---

## 6. Token Refresh

**Status:** Tokens expire after 1 hour, no refresh mechanism.
**Target:** Automatic token refresh for long agent sessions.

### Design
- Token has `exp` claim (1 hour from issuance)
- Mount client checks token expiry before each sync cycle
- If token expires in < 10 minutes: mint a new token locally (same secret, same scopes)
- For cloud: call POST `/api/v1/workspaces/{id}/join` to get a fresh token
- Update `RELAYFILE_TOKEN` env var in the agent's process (not possible for running process)
- Alternative: mount client refreshes its own token internally, agent's token is irrelevant
  since the mount client is what talks to relayfile

### What needs to happen
- Mount client (`syncer.go`): check token expiry before sync, re-mint if needed
- For local: re-sign with same secret (trivial)
- For cloud: call refresh endpoint

---

## 7. Cloud Relayauth Integration

**Status:** Two workflows written, may have failed/not completed.
**Target:** Orchestrator provisions agent identities + scoped tokens via relayauth.

### What needs to happen
1. Workflow launcher calls relayauth to create agent identities
2. Each agent gets a scoped token from relayauth (not a generic `mintRelayfileToken`)
3. Token scopes come from:
   - Workflow YAML `permissions:` field (user-defined)
   - `DEFAULT_SYSTEM_PERMISSIONS` (system-enforced)
   - Dotfile compiler output (if dotfiles present)
4. Relayfile validates tokens using shared secret with relayauth
5. Remove Daytona volume fallback — relayfile is the only file layer

### Workflows
- `cloud/workflows/cloud-relayauth-integration.ts`
- `cloud/workflows/relayauth-relayfile-linking.ts`

---

## 8. Automated E2E Test

**Status:** Manual testing only. No CI integration.
**Target:** Automated test that runs in CI and validates the full permission flow.

### Test script: `scripts/relay/e2e-permissions.sh`
1. Create temp project with test files + dotfiles
2. Start relayauth + relayfile
3. Provision (tokens, seed, ACLs)
4. Mount workspace
5. Verify:
   - Allowed files present and writable
   - Readonly files present and chmod 444
   - Ignored files absent
   - Server returns 403 for denied files
6. Write to readonly file → verify revert
7. Stop services, cleanup

### CI integration
- Add to `.github/workflows/ci.yml` in relayauth repo
- Requires Go (for relayfile binary) + Node.js
- Can run on ubuntu-latest (relayfile has linux/amd64 binary)

---

## 9. `agent-relay login` for Cloud Mode

**Status:** Not built.
**Target:** Authenticate with cloud API for workspace creation/joining.

### Design
```bash
agent-relay login
  → Opens browser to https://agentrelay.dev/auth
  → User logs in with GitHub/Google
  → Callback sets token in ~/.relay/credentials.json
  → Token used for POST /api/v1/workspaces/create and /join
```

### What needs to happen
1. Add `agent-relay login` command
2. OAuth flow (or device code flow for headless)
3. Store token in `~/.relay/credentials.json`
4. `agent-relay on` detects cloud credentials → uses cloud relayfile URL instead of localhost

---

## Priority Order

| # | Item | Blocks | Effort |
|---|------|--------|--------|
| 1 | npm publish packages | Cloud consumption, SDK imports | 30 min |
| 2 | SDK direct imports | Self-contained CLI | Workflow exists |
| 3 | Cloud relayauth integration | Per-agent scoped tokens in cloud | Workflow exists |
| 4 | Automated e2e test | CI confidence | 2 hours |
| 5 | Seeding without rsync | Cross-platform | Small fix |
| 6 | Token refresh | Long sessions | Medium |
| 7 | System events channel | Multi-agent coordination | Large |
| 8 | Cloud relayfile wiring (SST) | Production deployment | Medium |
| 9 | agent-relay login | Cloud mode UX | Medium |
