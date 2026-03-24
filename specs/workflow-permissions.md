# Workflow Permissions Specification

## Purpose

Define how relayauth + relayfile integrate with Agent Relay workflows to provide
declarative, enforceable permissions for agent steps. This replaces the binary
"sandboxed vs dangerously-allow" with scoped autonomy.

## Problem

Today's agent permission model:

| Mode | UX | Safety |
|------|-----|--------|
| Sandboxed (default) | Permission prompts every action | Safe but slow, kills autonomy |
| `--dangerously-allow` | No prompts | Fast but zero guardrails |
| AGENTS.md rules | No prompts | "Please don't" — not enforced |

What's needed: **agents run autonomously within declared, enforced boundaries.**

## Design

### Workflow-Level Permission Declarations

Permissions are declared per-agent in the workflow definition:

```typescript
workflow('build-feature')
  .agent('coder', {
    cli: 'codex',
    permissions: {
      fs: {
        read: ['*'],
        write: ['/src/**', '/tests/**', '/docs/**'],
        deny: ['/.env*', '/infra/**', '/secrets/**', '/.git/**']
      },
      vcs: {
        push: ['refs/heads/feat/*'],
        branchCreate: ['refs/heads/feat/*'],
        deny: ['refs/heads/main', 'refs/heads/release/*']
      },
      exec: {
        allow: ['npm test', 'npm run build', 'npx tsc'],
        deny: ['rm -rf', 'curl', 'wget', 'ssh']
      },
      network: {
        allow: ['localhost:*', 'registry.npmjs.org'],
        deny: ['*']  // deny-by-default for outbound
      }
    }
  })
  .agent('reviewer', {
    cli: 'claude',
    permissions: {
      fs: {
        read: ['*'],
        write: []  // read-only
      },
      vcs: {}  // no git operations
    }
  })
```

### Permission Resolution Pipeline

1. **Workflow declares** permissions per agent (developer authors this)
2. **Workflow runner** translates permissions to relayauth scope arrays
3. **Relayauth** mints a scoped JWT token for each agent
4. **Relayfile** mounts the workspace with the scoped token
5. **Agent runs** with `--dangerously-allow` (safe because scopes enforce limits)
6. **Operations** go through relayfile API → token validated → allowed/denied
7. **Denied operations** produce audit events with full context

### Permission-to-Scope Translation

The workflow runner translates the declarative `permissions` object into
relayauth scope strings:

```
fs.read: ['/src/**']     → relayfile:fs:read:/src/*
fs.write: ['/tests/**']  → relayfile:fs:write:/tests/*
fs.deny: ['/.env*']      → (omission — no scope granted for /.env*)
vcs.push: ['refs/heads/feat/*'] → relayfile:vcs:push:refs/heads/feat/*
exec.allow: ['npm test'] → relayfile:exec:run:npm-test
```

Deny rules work by omission: if no scope covers a path, the operation is denied.
Explicit deny entries are validated at declaration time to ensure no granted
scope accidentally covers a denied path.

### Deny Validation

At workflow start, before minting tokens:

1. Expand all `allow` patterns into concrete scope sets
2. For each `deny` pattern, verify no granted scope covers it
3. If a conflict exists, fail the workflow with a clear error:
   ```
   Permission conflict: fs.write grants '/src/**' which covers
   denied path '/src/secrets/'. Remove '/src/secrets/' from deny
   or narrow the write scope.
   ```

### Execution Flow

```
Developer writes workflow
        ↓
workflow.run() called
        ↓
For each agent:
  1. Translate permissions → scope arrays
  2. Validate deny rules don't conflict with allows
  3. Call relayauth: POST /v1/tokens/issue
     - scopes: [...translated scopes]
     - identity: agent_{workflow}_{step}_{agent}
     - sponsor: workflow owner's identity
     - ttl: step timeout + buffer
  4. Call relayfile: mount workspace with token
  5. Spawn agent CLI with:
     - RELAYFILE_TOKEN=<scoped token>
     - RELAYFILE_MOUNT=<mount path>
     - --dangerously-allow (safe: relayfile enforces)
  6. Agent runs autonomously
  7. On step complete: unmount, revoke token
        ↓
All denied operations logged to relayauth audit
```

### Default Permission Profiles

For convenience, pre-built profiles:

```typescript
import { profiles } from '@agent-relay/sdk/permissions';

// Coder: read all, write src/tests, push to feat branches
.agent('coder', { permissions: profiles.coder({ srcDirs: ['/src', '/tests'] }) })

// Reviewer: read-only everything
.agent('reviewer', { permissions: profiles.reviewer() })

// Deployer: read all, push to release branches, run deploy commands
.agent('deployer', { permissions: profiles.deployer({ releaseBranch: 'release/*' }) })

// Researcher: read-only, no git, no exec, limited network
.agent('researcher', { permissions: profiles.researcher() })
```

### Exec Scope (Command Execution)

File access alone isn't enough. Agents also run shell commands.

```
relayfile:exec:run:npm-test      → allow 'npm test'
relayfile:exec:run:npm-*         → allow any npm command
relayfile:exec:run:*             → allow any command (not recommended)
```

Command matching uses prefix matching on the normalized command string.
Dangerous commands (rm -rf, curl to external, etc.) require explicit scope.

### Network Scope

Agents making outbound HTTP requests:

```
relayfile:net:connect:localhost:*         → localhost any port
relayfile:net:connect:registry.npmjs.org  → npm registry
relayfile:net:connect:*                   → any outbound (not recommended)
```

Network enforcement requires the mount daemon to proxy or intercept outbound
connections. This is phase 2 — file and VCS scopes are phase 1.

### Audit Integration

Every denied operation produces an audit event:

```json
{
  "type": "permission.denied",
  "identity": "agent_build-feature_step1_coder",
  "sponsor": "khaliq@agentworkforce.com",
  "action": "fs:write",
  "target": "/.env.production",
  "scopes_held": ["relayfile:fs:write:/src/*", "relayfile:fs:write:/tests/*"],
  "reason": "no scope covers target path",
  "workflow": "build-feature",
  "step": "implement",
  "timestamp": "2026-03-24T20:00:00Z"
}
```

Dashboard shows: which agents hit guardrails, how often, what they tried.
This data feeds back into permission tuning.

### User Experience

**First time:**
```bash
# Define permissions in workflow
agent-relay run workflow.ts
# → "Minting scoped tokens for 3 agents..."
# → "Mounting workspace with fs:write:/src/* for coder..."
# → Agents run. No prompts. Guardrails enforced.
```

**When an agent hits a guardrail:**
```
[coder] Attempted to write to /infra/deploy.yaml — DENIED (no fs:write scope for /infra/)
[coder] Continuing with alternative approach...
```

The agent gets a clear error and can adapt. It's not a crash — it's a boundary.

**Permission report after run:**
```
┌─────────────────────────────────────────┐
│ Permission Report: build-feature        │
├─────────────────────────────────────────┤
│ coder:   142 allowed, 3 denied          │
│   denied: /.env (write), /infra/* (2x)  │
│ reviewer: 89 allowed, 0 denied          │
│ deployer: 12 allowed, 0 denied          │
└─────────────────────────────────────────┘
```

## Phases

### Phase 1: File + VCS Scopes
- relayfile:fs:read/write with path patterns
- relayfile:vcs:push with ref patterns
- Workflow runner mints tokens, mounts workspace
- Basic audit logging

### Phase 2: Exec + Network Scopes
- Command execution scoping
- Network access control
- Proxy-based enforcement in mount daemon

### Phase 3: Cross-Plane Scopes
- relaycast:channel:send — limit which channels agent can post to
- cloud:workflow:run — limit which workflows agent can trigger
- Full relayauth policy evaluation at every boundary

## Non-Goals

- Runtime permission escalation (agent cannot request more scopes mid-step)
- Interactive permission prompts (the whole point is to eliminate them)
- Per-file encryption (out of scope — this is access control, not data protection)
