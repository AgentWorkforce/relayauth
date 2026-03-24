# Agent Permissions Specification

## Purpose

Define how relayauth + relayfile provide declarative, enforceable permissions
for AI agents — whether running in Agent Relay workflows or ad-hoc from the
command line. This replaces the binary "sandboxed vs dangerously-allow" with
**scoped autonomy**: agents run with full autonomy inside declared boundaries.

This spec covers:
- The `.relay/permissions.yaml` configuration format
- The `relay` CLI and shell integration
- Filesystem scoping via relayfile sync daemon
- VCS (git) protection via pre-push hooks
- Cross-repo access via multi-mount
- MCP (Model Context Protocol) tool scoping via proxy
- Command execution scoping
- Network access control
- Distributed architecture (relayauth edge + relayfile local)
- Audit, reporting, and observability
- Performance requirements and latency budgets

---

## Problem

Today's agent permission model is binary:

| Mode | UX | Safety | Reality |
|------|-----|--------|---------|
| Sandboxed (default) | Permission prompts every action | Safe | Kills autonomy, agents can't work independently |
| `--dangerously-allow` | No prompts, full speed | None | Agent can read .env, push to main, delete files |
| AGENTS.md / CLAUDE.md rules | No prompts | Theater | "Please don't push to main" — not enforced |
| Codex sandbox | No prompts, read-only FS | Partial | Can't do real work (no writes, no git, no tools) |

Every option is a tradeoff between safety and usefulness. There is no middle
ground where an agent runs autonomously AND is constrained to safe boundaries.

**What's needed:** Agents run with zero permission prompts, full autonomy,
inside declared and enforced boundaries. The developer defines what the agent
can and cannot do. The system enforces it at the OS level. The agent doesn't
even know it's constrained — it just gets standard EACCES errors when it hits
a wall, and adapts.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Developer's Machine                       │
│                                                                   │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │ .relay/       │    │ relay CLI (Go binary)                │   │
│  │ permissions   │───→│                                      │   │
│  │ .yaml         │    │  ┌────────────┐  ┌───────────────┐  │   │
│  └──────────────┘    │  │ Shell Hook  │  │ Sync Daemon   │  │   │
│                       │  │ (cd hook)   │  │ (relayfile)   │  │   │
│                       │  └──────┬─────┘  └───────┬───────┘  │   │
│                       │         │                 │          │   │
│                       │  ┌──────┴─────────────────┴───────┐  │   │
│                       │  │ Permission Engine               │  │   │
│                       │  │ (JWT scope check, in-process)   │  │   │
│                       │  └──────┬─────────────────────────┘  │   │
│                       │         │                            │   │
│                       │  ┌──────┴─────┐  ┌───────────────┐  │   │
│                       │  │ MCP Proxy   │  │ Git Hooks     │  │   │
│                       │  │ (tool gate) │  │ (pre-push)    │  │   │
│                       │  └────────────┘  └───────────────┘  │   │
│                       └──────────────────────────────────────┘   │
│                                    │                              │
│  ┌─────────────────────────────────┴────────────────────────┐   │
│  │                    Agent CLI                              │   │
│  │  (claude / codex / pi / any CLI tool)                     │   │
│  │  Working directory: ~/.relay/mounts/<project>/            │   │
│  │  Sees normal filesystem. Doesn't know it's scoped.        │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │ auth.relay.dev      │
                    │ (Cloudflare Worker) │
                    │                    │
                    │ • Token issuance   │
                    │ • JWKS endpoint    │
                    │ • Audit log (D1)   │
                    │ • Identity mgmt    │
                    └────────────────────┘
                         Edge (global)
```

### Key Principle: Distributed Trust, Local Enforcement

**relayauth** (Cloudflare Worker) is the **authority**. It lives on the edge,
globally distributed. It issues tokens, publishes signing keys, stores audit
logs, and manages identities. Token issuance is one HTTPS call (~100-200ms).

**relayfile** (Go binary, runs locally) is the **enforcer**. It validates JWT
signatures against cached JWKS keys, checks scopes against file paths, and
blocks unauthorized operations. All enforcement is local — zero network calls
per file operation.

The JWT bridges the two systems. relayauth signs it, relayfile verifies it.
The token is self-contained: scopes, identity, expiry, all in the claims.
No database lookup needed at enforcement time.

```
Token issuance:  auth.relay.dev → JWT → local relay daemon
JWKS cache:      auth.relay.dev/.well-known/jwks.json → cached locally (24h TTL)
File operations: local only (JWT scope check, no network)
Audit upload:    batched, async, non-blocking (relay daemon → auth.relay.dev)
```

---

## Developer Experience

### Installation (once, ever)

```bash
brew install agentworkforce/tap/relay
```

Or without Homebrew:
```bash
curl -fsSL https://relay.dev/install.sh | sh
```

Downloads a single ~15MB Go binary. Cross-compiled for macOS (arm64, amd64)
and Linux (arm64, amd64). No runtime dependencies. No kernel extensions.
No Docker. No system restart.

**Time: ~10 seconds.**

### Authentication (once, ever)

```bash
relay login
```

Opens default browser → `relay.dev/auth` → OAuth flow (GitHub, Google, or
email) → links identity to relayauth → stores refresh token at
`~/.relay/credentials.json`.

Same flow as `gh auth login`, `npm login`, or `gcloud auth login`.

**Time: ~30 seconds.**

### Shell Integration (once, ever)

```bash
echo 'eval "$(relay shell)"' >> ~/.zshrc
source ~/.zshrc
```

This installs a `chpwd` hook (zsh) or `PROMPT_COMMAND` hook (bash) that
activates relay protection when entering a project with a
`.relay/permissions.yaml` file.

**Time: ~5 seconds.**

### Project Initialization (once per repo)

```bash
cd ~/Projects/my-app
relay auth init
```

Output:
```
Scanning project structure...
  ✓ TypeScript project (tsconfig.json found)
  ✓ Monorepo detected (packages/ directory, pnpm-workspace.yaml)
  ✓ Next.js app (packages/web/next.config.mjs)
  ✓ Sensitive files: .env, .env.local, .env.production
  ✓ Infrastructure: infra/, deploy/, terraform/
  ✓ Git remote: github.com/khaliq/my-app (main branch: main)
  ✓ MCP servers detected: github (from .claude/mcp.json)

Generated .relay/permissions.yaml

Default profile: coder
  FS read:   everything
  FS write:  /src/** /tests/** /packages/** /docs/**
  FS deny:   /.env* /secrets/** /.git/config /infra/**
  VCS push:  refs/heads/feat/* refs/heads/fix/*
  VCS block: refs/heads/main refs/heads/release/*
  MCP allow: github (read ops), filesystem (deny all)

Review and edit .relay/permissions.yaml, then commit it to share with your team.
```

The scanner detects:
- **Language/framework** (TypeScript, Python, Go, Rust, etc.)
- **Project structure** (monorepo, single package, src/lib layout)
- **Sensitive files** (.env, credentials, keys, secrets directories)
- **Infrastructure** (terraform, CDK, deploy scripts, CI configs)
- **Git configuration** (default branch name, remote URL)
- **MCP servers** (from `.claude/mcp.json`, `.cursor/mcp.json`, `mcp.json`)
- **Existing ignore patterns** (.gitignore as a signal for what's sensitive)

**Time: ~3 seconds.**

### Daily Usage (every time — zero steps)

```bash
cd ~/Projects/my-app    # shell hook activates (once, ~300ms)
claude                  # agent runs scoped — no flags, no wrapping
```

**That's it.** No `relay wrap`. No flags. No environment variables to set.
The shell hook detected the project, minted a token, started the sync daemon,
and redirected the working directory — all transparently.

---

## Configuration Format

### `.relay/permissions.yaml`

This file is the single source of truth for agent permissions in a project.
It is human-readable YAML, version-controlled, and shared with the team.

```yaml
# .relay/permissions.yaml
# Agent permissions for my-app
# Docs: https://relay.dev/docs/permissions

# The default profile used when no --profile flag is specified
default: coder

profiles:
  # ── Coder Profile ────────────────────────────────────────────────
  # For agents that implement features, fix bugs, write tests.
  coder:
    fs:
      read:
        - "*"                          # can read everything
      write:
        - "/src/**"                    # application source
        - "/tests/**"                  # test files
        - "/packages/**"              # monorepo packages
        - "/docs/**"                   # documentation
        - "/scripts/**"               # build/dev scripts
        - "*.md"                       # markdown files anywhere
        - "package.json"              # dependency management
        - "tsconfig*.json"            # TypeScript config
      deny:
        - "/.env*"                     # environment variables
        - "/secrets/**"               # secrets directory
        - "/.git/config"              # git credentials
        - "/.git/hooks/**"            # git hooks (managed by relay)
        - "/infra/**"                 # infrastructure code
        - "/deploy/**"                # deployment scripts
        - "/.relay/**"               # relay config itself
        - "**/credentials*"           # any credentials file
        - "**/*.pem"                  # certificates
        - "**/*.key"                  # private keys

    vcs:
      push:
        - "refs/heads/feat/*"         # feature branches
        - "refs/heads/fix/*"          # bugfix branches
        - "refs/heads/chore/*"        # chore branches
        - "refs/heads/test/*"         # test branches
      branchCreate:
        - "refs/heads/feat/*"
        - "refs/heads/fix/*"
      branchDelete: []                 # cannot delete branches
      tag: []                          # cannot create tags
      forcePush: []                    # never force push
      deny:
        - "refs/heads/main"
        - "refs/heads/master"
        - "refs/heads/release/*"
        - "refs/heads/production"
        - "refs/tags/*"               # cannot push tags

    exec:
      allow:
        - "npm test"                   # test runner
        - "npm run *"                  # npm scripts
        - "npx tsc*"                   # TypeScript compiler
        - "npx jest*"                  # test runner
        - "npx eslint*"               # linter
        - "npx prettier*"             # formatter
        - "pnpm *"                     # pnpm commands
        - "node *"                     # node scripts
        - "git add *"                  # staging
        - "git commit *"              # committing
        - "git push *"                # pushing (VCS scopes still apply)
        - "git checkout *"            # switching branches
        - "git branch *"              # branch management
        - "git diff *"                # viewing changes
        - "git log *"                 # viewing history
        - "git status"                # status
        - "cat *"                      # reading files
        - "ls *"                       # listing
        - "find *"                     # finding files
        - "grep *"                     # searching
        - "mkdir *"                    # creating directories
        - "cp *"                       # copying (FS scopes still apply)
        - "mv *"                       # moving (FS scopes still apply)
      deny:
        - "rm -rf *"                   # recursive delete
        - "rm -r *"                    # recursive delete
        - "sudo *"                     # privilege escalation
        - "chmod *"                    # permission changes
        - "chown *"                    # ownership changes
        - "curl *"                     # HTTP requests (use network scope)
        - "wget *"                     # HTTP requests
        - "ssh *"                      # remote access
        - "scp *"                      # remote copy
        - "rsync *"                    # remote sync
        - "docker *"                   # container operations
        - "kubectl *"                  # kubernetes
        - "terraform *"               # infrastructure
        - "aws *"                      # cloud CLI
        - "gcloud *"                   # cloud CLI
        - "az *"                       # cloud CLI
        - "eval *"                     # arbitrary code execution
        - "exec *"                     # process replacement
        - "kill *"                     # process management
        - "pkill *"                    # process management

    network:
      allow:
        - "localhost:*"                # local services
        - "127.0.0.1:*"              # local services
        - "registry.npmjs.org"        # npm registry
        - "github.com"                # git operations
        - "api.github.com"            # GitHub API
      deny:
        - "*"                          # deny-by-default for all other outbound

    mcp:
      - server: github
        allow:
          - tool: search_issues
          - tool: list_issues
          - tool: get_issue
          - tool: create_issue
          - tool: search_code
          - tool: read_file
            constraint: { repo: "$REPO" }     # only current repo
          - tool: create_pull_request
            constraint: { repo: "$REPO" }
          - tool: list_pull_requests
          - tool: get_pull_request
          - tool: create_review
        deny:
          - tool: delete_repository
          - tool: create_repository
          - tool: update_repository_settings
          - tool: create_webhook
          - tool: delete_webhook
          - tool: transfer_repository

      - server: postgres
        deny: ["*"]                    # no database access for coder

      - server: filesystem
        deny: ["*"]                    # blocked — use relay FS instead

      - server: slack
        allow:
          - tool: search_messages
          - tool: list_channels
        deny:
          - tool: post_message         # cannot post as human
          - tool: send_dm
          - tool: delete_message

    mounts: []                         # no cross-repo access by default

  # ── Reviewer Profile ─────────────────────────────────────────────
  # For agents that review code, analyze quality, suggest improvements.
  # Read-only access to everything, no writes, no git, no tools.
  reviewer:
    fs:
      read: ["*"]
      write: []                        # completely read-only
      deny: ["/.env*", "/secrets/**"]  # can't even read secrets
    vcs: {}                            # no git operations
    exec:
      allow:
        - "cat *"
        - "ls *"
        - "find *"
        - "grep *"
        - "git log *"
        - "git diff *"
        - "git show *"
        - "npx tsc --noEmit"          # can check types
      deny: ["*"]                      # deny everything else
    network:
      deny: ["*"]
    mcp:
      - server: github
        allow:
          - tool: search_code
          - tool: read_file
          - tool: list_pull_requests
          - tool: get_pull_request
        deny: ["*"]

  # ── Deployer Profile ─────────────────────────────────────────────
  # For agents that deploy, manage infrastructure, handle releases.
  deployer:
    fs:
      read: ["*"]
      write:
        - "/infra/**"
        - "/deploy/**"
        - "/terraform/**"
        - "/.github/workflows/**"
      deny:
        - "/.env.production"           # production secrets
        - "/secrets/**"
        - "/src/**"                    # cannot modify application code
    vcs:
      push:
        - "refs/heads/release/*"
        - "refs/heads/deploy/*"
      tag:
        - "refs/tags/v*"              # can create version tags
      deny:
        - "refs/heads/main"           # still no direct push to main
        - "refs/heads/feat/*"         # not a feature branch
    exec:
      allow:
        - "terraform *"
        - "aws *"
        - "docker *"
        - "npm run deploy*"
        - "git tag *"
      deny:
        - "rm -rf *"
        - "sudo *"
    mcp:
      - server: github
        allow:
          - tool: create_release
          - tool: list_releases
          - tool: create_pull_request
        deny:
          - tool: delete_repository

  # ── Researcher Profile ───────────────────────────────────────────
  # For agents that gather information, analyze, research.
  # Read-only FS, limited network, no git, no exec.
  researcher:
    fs:
      read: ["*"]
      write: ["/tmp/**", "/research/**"]  # can write research notes
      deny: ["/.env*", "/secrets/**"]
    vcs: {}
    exec:
      allow:
        - "cat *"
        - "ls *"
        - "grep *"
        - "find *"
      deny: ["*"]
    network:
      allow:
        - "*.google.com"
        - "*.stackoverflow.com"
        - "*.github.com"
        - "api.openai.com"
      deny: ["*"]
    mcp:
      - server: github
        allow:
          - tool: search_code
          - tool: search_issues
          - tool: read_file
        deny: ["*"]

# ── Cross-Repo Mounts ───────────────────────────────────────────
# Define additional repositories that agents can access.
# Each mount appears as a subdirectory in the agent's workspace.
mounts:
  # Example: shared library (read-only reference)
  # - name: shared-lib
  #   source: ~/Projects/shared-lib
  #   path: /refs/shared-lib
  #   profiles:
  #     coder: { read: ["*"], write: [] }
  #     reviewer: { read: ["*"], write: [] }

  # Example: API contracts (partial read)
  # - name: api-contracts
  #   source: ~/Projects/api-contracts
  #   path: /refs/api-contracts
  #   profiles:
  #     coder: { read: ["/schemas/**", "/openapi.yaml"], write: [] }

  # Example: monorepo parent (write only own package)
  # - name: monorepo
  #   source: ../../..
  #   path: /monorepo
  #   profiles:
  #     coder: { read: ["*"], write: ["/packages/my-package/**"] }

# ── Settings ────────────────────────────────────────────────────
settings:
  # Token TTL in seconds (default: 3600 = 1 hour)
  tokenTTL: 3600

  # Auto-refresh token before expiry (default: true)
  autoRefresh: true

  # Show session report on exit (default: true)
  showReport: true

  # Upload audit events to relay.dev (default: true)
  auditUpload: true

  # Local audit log path (always written regardless of upload)
  auditLog: .relay/audit.log

  # relayauth server URL (default: production edge)
  authServer: https://auth.relay.dev

  # How to handle missing permissions.yaml when shell hook activates
  # "ignore" = no protection, "default" = use built-in defaults, "warn" = print warning
  missingConfig: default
```

---

## Scope Format

Permissions in the YAML are translated to relayauth scope strings for the JWT:

### Filesystem Scopes
```
relayfile:fs:read:{path}           # read file or directory
relayfile:fs:write:{path}          # write/create/modify file
relayfile:fs:delete:{path}         # delete file
relayfile:fs:list:{path}           # list directory contents
```

Path patterns:
- `*` — everything (root wildcard)
- `/src/*` — everything under /src/ (recursive)
- `/src/*.ts` — TypeScript files in /src/ (non-recursive)
- `*.md` — markdown files anywhere
- `/package.json` — exact file

### VCS Scopes
```
relayfile:vcs:push:{ref-pattern}         # push commits
relayfile:vcs:force-push:{ref-pattern}   # force push
relayfile:vcs:branch-create:{ref-pattern} # create branch
relayfile:vcs:branch-delete:{ref-pattern} # delete branch
relayfile:vcs:tag:{ref-pattern}          # create/push tag
```

Ref patterns:
- `refs/heads/feat/*` — any feature branch
- `refs/heads/main` — exact branch
- `refs/tags/v*` — version tags
- `refs/heads/*` — any branch

### Exec Scopes
```
relayfile:exec:run:{command-pattern}     # execute command
```

Command patterns:
- `npm-test` — exact command (`npm test`, normalized)
- `npm-*` — any npm command
- `git-*` — any git command
- `*` — any command (not recommended)

Normalization: spaces → hyphens, arguments appended with hyphens.
`npm run build` → `npm-run-build`. Matching is prefix-based.

### Network Scopes
```
relayfile:net:connect:{host}:{port}      # outbound connection
relayfile:net:connect:{host}:*           # any port on host
relayfile:net:connect:*                  # any outbound (not recommended)
```

### MCP Scopes
```
relayfile:mcp:{server}:{tool}            # call specific tool
relayfile:mcp:{server}:{tool}:{constraint} # call with constraint
relayfile:mcp:{server}:*                 # any tool on server
```

Constraints are key-value pairs encoded after the tool name:
- `relayfile:mcp:github:read_file:repo=my-org/my-repo`
- `relayfile:mcp:postgres:query:tables=users,products`

### Mount Scopes

Cross-repo mounts generate additional scopes on the same token:
```
relayfile:fs:read:/@mount/{mount-name}/{path}
relayfile:fs:write:/@mount/{mount-name}/{path}
```

The `/@mount/` prefix distinguishes mount paths from primary project paths.

---

## Enforcement Mechanisms

### Filesystem Enforcement (Sync Daemon)

The relay CLI runs a sync daemon that maintains a bidirectional sync between
the real project directory and a mount directory:

```
~/Projects/my-app/              ← real directory (untouched by agent)
~/.relay/mounts/my-app/         ← synced copy (agent works here)
```

The shell hook transparently redirects `PWD` to the mount directory when
entering a relay-protected project. The prompt is aliased so `pwd` still
shows the original path.

**On agent write:**
1. Agent writes to `~/.relay/mounts/my-app/src/index.ts`
2. Sync daemon intercepts the fsnotify event
3. Daemon checks JWT scope: `relayfile:fs:write:/src/*` → ALLOW
4. Daemon syncs the write to `~/Projects/my-app/src/index.ts`
5. Agent sees successful write (~0.5ms overhead)

**On agent write (denied):**
1. Agent writes to `~/.relay/mounts/my-app/.env.local`
2. Sync daemon intercepts
3. Daemon checks JWT scope: no `relayfile:fs:write:/.env*` → DENY
4. Daemon deletes the written file from mount immediately
5. Daemon writes audit event
6. Agent sees the file disappear (like a write error)
   OR daemon pre-configures mount directory with read-only permissions
   on denied paths → agent gets EACCES at OS level

**Pre-denial via filesystem permissions (preferred):**
On mount initialization, the daemon sets filesystem permissions on the mount
directory to match the token scopes:
- Denied write paths → `chmod 444` (read-only at OS level)
- Denied read paths → files not synced to mount (invisible)
- Allowed write paths → `chmod 644` (normal)

This means denied operations fail at the OS level with standard EACCES errors.
The agent sees a normal permission error and adapts. No relay-specific error
codes needed.

### VCS Enforcement (Git Hooks)

On mount initialization, the relay daemon installs a `pre-push` hook in the
mount directory's `.git/hooks/`:

```bash
#!/usr/bin/env bash
# Managed by relay — do not edit
exec relay vcs validate-push "$@"
```

The `relay vcs validate-push` command:
1. Reads the JWT from `RELAYFILE_TOKEN` environment
2. Parses the remote and ref arguments from git
3. Checks each ref against VCS scopes in the token
4. Allows or denies the push with a clear message

```
$ git push origin main
relay: ❌ Push denied — refs/heads/main not in VCS scope
relay: Allowed refs: refs/heads/feat/*, refs/heads/fix/*
relay: Tip: push to a feature branch instead: git push origin feat/my-feature
```

The hook is installed in the mount directory only — the real project's hooks
are untouched.

### Exec Enforcement (Command Proxy)

The relay daemon intercepts command execution through a PATH shim:

On mount activation, relay prepends `~/.relay/bin/` to PATH. This directory
contains shim scripts for dangerous commands that check scopes before
executing the real command:

```
~/.relay/bin/rm          → checks relayfile:exec:run:rm-* scope
~/.relay/bin/curl        → checks relayfile:exec:run:curl-* scope
~/.relay/bin/ssh         → checks relayfile:exec:run:ssh-* scope
~/.relay/bin/docker      → checks relayfile:exec:run:docker-* scope
~/.relay/bin/terraform   → checks relayfile:exec:run:terraform-* scope
```

If the scope is present, the shim calls the real binary. If not, it prints
a clear denial message and exits with code 126 (command not executable).

Commands not in the shim directory are unaffected — only explicitly denied
commands are intercepted.

### Network Enforcement (Proxy/Firewall)

Phase 2 implementation. Two approaches:

**Option A: HTTP proxy (simpler)**
Set `HTTP_PROXY` and `HTTPS_PROXY` environment variables to point at the
relay daemon's local proxy. The proxy checks the destination against
network scopes before forwarding. Works for HTTP/HTTPS traffic.

**Option B: Network namespace (Linux only)**
On Linux, use network namespaces to isolate the agent process. Only
allowed destinations are routable. More thorough but platform-specific.

For phase 1, network scoping is informational only — the relay daemon logs
outbound connections but doesn't block them. Phase 2 adds enforcement.

### MCP Enforcement (Tool Proxy)

The relay daemon runs a local MCP proxy that sits between the agent and
real MCP servers:

**Setup:** On mount activation, relay:
1. Reads the agent's MCP configuration (`.claude/mcp.json`, etc.)
2. For each configured MCP server, creates a proxied version
3. Rewrites the MCP config in the mount directory to point at the proxies
4. The agent connects to proxied MCP servers transparently

**Architecture:**
```
Agent → relay MCP proxy (localhost:RELAY_PORT/mcp/github) → real GitHub MCP server
```

**On tool call:**
1. Agent calls `github.create_pull_request({ repo: "other-org/secret-repo" })`
2. Proxy receives the call
3. Proxy checks JWT: `relayfile:mcp:github:create_pull_request:repo=my-org/my-repo`
4. Constraint check: `other-org/secret-repo` ≠ `my-org/my-repo` → DENY
5. Proxy returns MCP error: `{ error: "Permission denied: tool not available for this repository" }`
6. Agent adapts

**Tool visibility:**
Denied tools are hidden from the MCP `tools/list` response. The agent doesn't
know they exist. This prevents the agent from trying to use them and then
reasoning about workarounds.

```
Agent calls tools/list on proxied github server:
  Real tools: [search_issues, create_issue, delete_repository, ...]
  Filtered:   [search_issues, create_issue, ...]  (delete_repository hidden)
```

**Server-level deny:**
If a server has `deny: ["*"]`, the proxy returns an empty tools list. The
agent sees the MCP server as having no available tools.

**Constraint variables:**
The `$REPO` variable in constraints is resolved from the project's git remote:
```yaml
constraint: { repo: "$REPO" }
# resolves to: { repo: "khaliq/my-app" } from git remote URL
```

Other variables:
- `$REPO` — git remote repository (org/name)
- `$BRANCH` — current git branch
- `$USER` — relay identity username
- `$PROJECT` — project directory name

---

## Cross-Repo Mounts

### Purpose

Agents often need to reference other repositories — shared libraries, API
contracts, monorepo siblings, infrastructure code. Cross-repo mounts provide
controlled access to external directories without giving the agent unrestricted
filesystem access.

### Configuration

```yaml
mounts:
  - name: shared-lib
    source: ~/Projects/shared-lib        # absolute or relative path
    path: /refs/shared-lib               # where it appears in mount
    profiles:
      coder: { read: ["*"], write: [] }  # read-only for coders
      deployer: { read: ["*"], write: ["/dist/**"] }  # deployers can write dist

  - name: api-contracts
    source: ~/Projects/api-contracts
    path: /refs/api-contracts
    profiles:
      coder:
        read: ["/schemas/**", "/openapi.yaml"]  # partial read
        write: []

  - name: monorepo-root
    source: ../../..                     # relative to project root
    path: /monorepo
    profiles:
      coder:
        read: ["*"]                      # can read entire monorepo
        write: ["/packages/my-package/**"]  # can only write own package
```

### How It Works

1. Sync daemon creates subdirectories in the mount:
   ```
   ~/.relay/mounts/my-app/
   ├── src/                    ← primary project
   ├── tests/
   ├── refs/
   │   ├── shared-lib/        ← mounted from ~/Projects/shared-lib
   │   └── api-contracts/     ← mounted from ~/Projects/api-contracts
   └── monorepo/              ← mounted from ../../../
   ```

2. Each mount has independent sync with independent permissions
3. The agent sees a unified directory tree
4. Writes to mounted directories go through their own scope checks
5. Each mount can have different access levels per profile

### Mount Scoping

Each mount generates separate scopes in the JWT:
```
relayfile:fs:read:/@mount/shared-lib/*
relayfile:fs:read:/@mount/api-contracts/schemas/*
relayfile:fs:read:/@mount/api-contracts/openapi.yaml
relayfile:fs:read:/@mount/monorepo-root/*
relayfile:fs:write:/@mount/monorepo-root/packages/my-package/*
```

### Resolution Rules

- **Absolute paths** (`~/Projects/shared-lib`): used as-is
- **Relative paths** (`../../..`): resolved relative to the project root
  (the directory containing `.relay/permissions.yaml`)
- **Missing sources**: mount is skipped with a warning (not an error)
- **Circular mounts**: detected and rejected (A mounts B, B mounts A)
- **Nested mounts**: allowed (A mounts B, B's mount of C is NOT inherited —
  only explicit mounts in A's config are included)

---

## Token Lifecycle

### Minting

When the shell hook activates (or `relay wrap` is called):

1. Relay CLI reads `.relay/permissions.yaml`
2. Determines active profile (default or `--profile` flag)
3. Translates permissions to scope array
4. Validates deny rules don't conflict with allows
5. Calls relayauth: `POST https://auth.relay.dev/v1/tokens/issue`
   ```json
   {
     "identity": "dev:khaliq:my-app:coder",
     "scopes": ["relayfile:fs:read:*", "relayfile:fs:write:/src/*", ...],
     "ttl": 3600,
     "metadata": {
       "project": "my-app",
       "profile": "coder",
       "machine": "khaliq-macbook"
     }
   }
   ```
6. Receives signed JWT
7. Stores token in memory (sync daemon process)

### Refresh

Before token expiry (at 80% of TTL = 48 minutes for 1 hour token):

1. Relay daemon calls: `POST https://auth.relay.dev/v1/tokens/refresh`
2. Receives new JWT with fresh expiry
3. Hot-swaps token in memory — no interruption to agent
4. If refresh fails (network error), daemon uses remaining time on current
   token and retries with exponential backoff

### Revocation

On session end (agent exits, `cd` out of project, terminal closes):

1. Relay daemon calls: `POST https://auth.relay.dev/v1/tokens/revoke`
2. Token added to relayauth's revocation KV store
3. Local mount is unmounted
4. Session report is displayed

Revocation is best-effort — if the network is down, the token expires
naturally via TTL. The revocation call is async and non-blocking.

### Offline Mode

If relayauth is unreachable during token minting:

1. Check for cached token from previous session (if not expired)
2. If no cache, use a locally-generated development token:
   - Signed with a local key (not trusted by remote relayfile)
   - Valid only for local mount operations
   - Flagged as `offline: true` in audit log
   - Cannot be used against remote relayfile instances

This ensures developers can work on planes, trains, and in tunnels.

---

## Workflow Integration

### Agent Relay Workflows

When running `relay run workflow.ts`, the runner integrates permissions
automatically:

```typescript
workflow('build-feature')
  .agent('coder', {
    cli: 'codex',
    permissions: {
      fs: { read: ['*'], write: ['/src/**', '/tests/**'] },
      vcs: { push: ['refs/heads/feat/*'] },
      mcp: [{ server: 'github', allow: ['search_issues', 'create_pull_request'] }]
    }
  })
  .agent('reviewer', {
    cli: 'claude',
    permissions: profiles.reviewer()  // built-in profile
  })
```

The runner:
1. Reads each agent's permissions
2. Merges with `.relay/permissions.yaml` if present (workflow overrides take
   precedence, but cannot exceed the project's global limits)
3. Mints separate tokens per agent
4. Each agent runs in its own scoped mount
5. On step completion, agent's token is revoked immediately

### Permission Inheritance

When both `.relay/permissions.yaml` and workflow permissions exist:

```
Project permissions:  fs.write = ["/src/**", "/tests/**", "/docs/**"]
Workflow permissions: fs.write = ["/src/**", "/tests/**", "/packages/**"]

Effective permissions: fs.write = ["/src/**", "/tests/**"]
  (intersection — workflow cannot exceed project limits)
```

The project-level config sets the ceiling. Workflow-level config can only
narrow, never widen.

### SDK Types

```typescript
import { AgentPermissions, PermissionProfile, profiles } from '@agent-relay/sdk/permissions';

interface AgentPermissions {
  fs?: {
    read?: string[];
    write?: string[];
    deny?: string[];
  };
  vcs?: {
    push?: string[];
    forcePush?: string[];
    branchCreate?: string[];
    branchDelete?: string[];
    tag?: string[];
    deny?: string[];
  };
  exec?: {
    allow?: string[];
    deny?: string[];
  };
  network?: {
    allow?: string[];
    deny?: string[];
  };
  mcp?: McpPermission[];
  mounts?: MountPermission[];
}

interface McpPermission {
  server: string;
  allow?: (string | { tool: string; constraint?: Record<string, string> })[];
  deny?: string[];
}

interface MountPermission {
  name: string;
  source: string;
  path: string;
  read?: string[];
  write?: string[];
}
```

---

## Deny Validation

Before minting a token, the relay CLI validates that deny rules don't conflict
with allow rules:

### Algorithm

1. For each allow pattern, expand to a concrete scope
2. For each deny pattern, check if any allow scope covers it
3. If a conflict exists, fail with a clear error

### Examples

**Valid — no conflict:**
```yaml
fs:
  write: ["/src/**"]           # allows /src/ subtree
  deny: ["/.env*"]             # denies .env files (not under /src/)
```

**Conflict — caught at startup:**
```yaml
fs:
  write: ["/**"]               # allows everything
  deny: ["/secrets/**"]        # tries to deny /secrets/
```
Error:
```
Permission conflict in profile 'coder':
  fs.write pattern '/**' covers denied path '/secrets/**'
  
  Options:
  1. Narrow fs.write: ["/src/**", "/tests/**"] (exclude /secrets/)
  2. Remove /secrets/** from deny (already inaccessible if not in write)
```

**Conflict in MCP:**
```yaml
mcp:
  - server: github
    allow: ["*"]               # allows all tools
    deny: ["delete_repository"] # tries to deny one
```
Error:
```
MCP permission conflict for server 'github':
  allow: '*' covers denied tool 'delete_repository'
  
  List allowed tools explicitly instead of using '*'
```

---

## CLI Reference

### `relay login`

Authenticate with relay.dev.

```bash
relay login                    # interactive OAuth flow
relay login --token <pat>      # use personal access token
relay login --status           # show current auth status
relay logout                   # clear credentials
```

### `relay shell`

Output shell hook code for automatic project activation.

```bash
eval "$(relay shell)"          # install in current shell
eval "$(relay shell --zsh)"    # force zsh syntax
eval "$(relay shell --bash)"   # force bash syntax
eval "$(relay shell --fish)"   # force fish syntax
```

### `relay auth init`

Scan project and generate `.relay/permissions.yaml`.

```bash
relay auth init                # scan and generate
relay auth init --profile coder # only generate coder profile
relay auth init --force        # overwrite existing config
relay auth init --dry-run      # show what would be generated
```

### `relay auth check`

Validate permissions.yaml and show effective permissions.

```bash
relay auth check               # validate config
relay auth check --profile coder # show coder's effective permissions
relay auth check --verbose     # show scope translation details
```

Output:
```
Profile: coder
  FS Read:     * (everything)
  FS Write:    /src/** /tests/** /packages/** /docs/**
  FS Deny:     /.env* /secrets/** /.git/config /infra/**
  VCS Push:    refs/heads/feat/* refs/heads/fix/*
  VCS Block:   refs/heads/main refs/heads/release/*
  Exec Allow:  npm test, npm run *, npx tsc*, git *, ...
  Exec Block:  rm -rf, sudo, curl, ssh, docker, ...
  MCP:         github (6 tools), postgres (denied), slack (2 tools)
  Mounts:      shared-lib (read-only), api-contracts (partial read)
  Token TTL:   3600s (1 hour)

  Validation: ✅ PASS (no conflicts)
  Scopes:     47 total
```

### `relay auth test`

Dry-run permission check without running an agent.

```bash
relay auth test write /src/index.ts          # ✅ allowed (coder)
relay auth test write /.env.local            # ❌ denied (coder)
relay auth test push refs/heads/main         # ❌ denied (coder)
relay auth test push refs/heads/feat/login   # ✅ allowed (coder)
relay auth test exec "npm test"              # ✅ allowed (coder)
relay auth test exec "docker build ."        # ❌ denied (coder)
relay auth test mcp github delete_repository # ❌ denied (coder)
relay auth test mcp github search_issues     # ✅ allowed (coder)
relay auth test --profile reviewer write /src/index.ts  # ❌ denied
```

### `relay auth report`

Show last session's permission activity.

```bash
relay auth report              # latest session
relay auth report --session <id> # specific session
relay auth report --json       # JSON output
```

Output:
```
┌─ Session: abc123 — claude (3m 42s) ─────────────────────┐
│  Profile: coder                                          │
│  Token:   eyJ...K4w (expires in 56m)                    │
│                                                          │
│  ── Filesystem ──────────────────────────────────────── │
│  142 operations │ 3 denied                               │
│  ├─ ✅ /src/api/route.ts (write)                        │
│  ├─ ✅ /src/lib/utils.ts (write)                        │
│  ├─ ✅ /tests/api.test.ts (write)                       │
│  ├─ ❌ /.env.local (write) → no fs:write scope          │
│  ├─ ❌ /infra/deploy.yaml (write) → no fs:write scope   │
│  └─ ❌ /secrets/api-key.txt (read) → no fs:read scope   │
│                                                          │
│  ── VCS ─────────────────────────────────────────────── │
│  2 operations │ 1 denied                                 │
│  ├─ ✅ git push origin feat/login                       │
│  └─ ❌ git push origin main → ref not in vcs:push scope │
│                                                          │
│  ── MCP ─────────────────────────────────────────────── │
│  28 calls │ 1 denied                                     │
│  ├─ ✅ github.search_issues (12x)                       │
│  ├─ ✅ github.create_pull_request (1x)                  │
│  ├─ ❌ postgres.query → server denied                   │
│  └─ ✅ github.read_file (14x)                           │
│                                                          │
│  ── Exec ────────────────────────────────────────────── │
│  8 commands │ 0 denied                                   │
│  ├─ ✅ npm test (3x)                                    │
│  ├─ ✅ npx tsc --noEmit (2x)                           │
│  └─ ✅ git commit -m "..." (3x)                         │
│                                                          │
│  💡 Suggestions:                                         │
│  • Agent tried to write /infra/ 2x — add to coder.fs    │
│    if this agent needs infrastructure access.             │
│  • Agent tried to read /secrets/ — consider creating     │
│    a deployer profile with secrets access.                │
└──────────────────────────────────────────────────────────┘
```

### `relay auth audit`

Historical audit log across all sessions.

```bash
relay auth audit               # last 20 sessions
relay auth audit --last 7d     # last 7 days
relay auth audit --denied-only # only show denied operations
relay auth audit --agent claude # filter by agent
relay auth audit --profile coder # filter by profile
relay auth audit --json        # JSON output
relay auth audit --export csv  # export to CSV
```

Output:
```
Date        Agent    Profile    Allowed  Denied  Top Denials
2026-03-24  claude   coder      142      3       /.env (2x), /infra (1x)
2026-03-24  codex    coder      89       0       —
2026-03-23  claude   reviewer   234      0       —
2026-03-23  claude   coder      67       1       git push main
2026-03-22  codex    deployer   34       2       /src (1x), npm install (1x)
2026-03-21  claude   coder      156      0       —
```

### `relay auth suggest`

AI-powered permission tuning based on denied operations.

```bash
relay auth suggest             # analyze recent denials
relay auth suggest --apply     # apply suggestions automatically
relay auth suggest --last 30d  # analyze last 30 days
```

Output:
```
Based on 14 denied operations across 8 sessions:

1. Add /infra/monitoring/** to coder.fs.write
   Reason: 6 denied writes to monitoring configs — agent frequently
   needs to update alerting rules. Low risk (not deploy scripts).
   Risk: LOW — monitoring configs, not deployment

2. Add 'docker build *' to coder.exec.allow
   Reason: 4 denied docker builds — agent builds containers for testing.
   Risk: MEDIUM — docker can mount host filesystem
   
3. Remove postgres.query from coder.mcp.deny
   Reason: 3 denied queries — agent needs to inspect schema.
   Suggestion: allow with constraint: { tables: ["schema_*"] }
   Risk: LOW — read-only schema inspection

Apply all? [y/N/select]
```

### `relay auth install-hooks`

Install global git hooks for VCS protection (works without full relay setup).

```bash
relay auth install-hooks             # install global pre-push hook
relay auth install-hooks --uninstall # remove global hooks
relay auth install-hooks --check     # verify hooks are installed
```

This is the lightweight option for teams that only need git branch protection
without full filesystem scoping.

### `relay wrap`

Explicitly wrap a command with relay permissions (alternative to shell hook).

```bash
relay wrap claude                        # default profile
relay wrap codex --profile reviewer      # specific profile
relay wrap vim                           # works with any CLI
relay wrap npm test                      # scoped test runner
relay wrap --allow-push-main claude      # quick override
relay wrap --no-mcp claude              # skip MCP proxying
relay wrap --no-vcs claude              # skip VCS hooks
relay wrap --dry-run claude             # show what would be set up
```

### `relay status`

Show current relay state.

```bash
relay status
```

Output:
```
Relay v1.2.0
Auth: khaliq@agentworkforce.com (authenticated)
Shell hook: active (zsh chpwd)

Active mounts:
  ~/Projects/my-app → ~/.relay/mounts/my-app (coder, 42m remaining)
  ~/Projects/shared-lib → ~/.relay/mounts/shared-lib (reviewer, 18m remaining)

Daemon: running (PID 12345, 2 mounts, 3 MCP proxies)
Audit: 47 events today (3 denied)
```

---

## Performance Budgets

### Latency Targets

| Operation | Target | Network? | Notes |
|-----------|--------|----------|-------|
| `cd` into project (first time) | <500ms | Yes (1 HTTPS) | Token mint + daemon start |
| `cd` into project (daemon running) | <10ms | No | Reuse existing mount |
| `cd` out of project | <5ms | No | Lazy unmount scheduled |
| File read (through mount) | <1ms overhead | No | In-memory scope check |
| File write (allowed) | <1ms overhead | No | Scope check + sync to source |
| File write (denied) | <0.5ms | No | OS-level EACCES |
| Directory listing | <1ms overhead | No | Pre-filtered at sync time |
| git push (allowed) | <50ms overhead | No | Pre-push hook scope check |
| git push (denied) | <50ms | No | Fails fast with clear message |
| MCP tool call (allowed) | <5ms overhead | No | Local proxy, scope check |
| MCP tool call (denied) | <2ms | No | Immediate rejection |
| Command exec (allowed) | <2ms overhead | No | Shim → real binary |
| Command exec (denied) | <1ms | No | Shim rejects |
| Token refresh | <200ms | Yes (1 HTTPS) | Background, non-blocking |
| Session report | <50ms | No | Local audit log read |
| Audit upload | async | Yes | Batched, non-blocking |

### Resource Usage

| Resource | Budget | Notes |
|----------|--------|-------|
| Memory (daemon) | <50MB | File index + token + scope cache |
| CPU (idle) | <1% | fsnotify wait, no polling |
| CPU (active sync) | <5% | Burst during file changes |
| Disk (mount) | 1:1 with project | Full sync (could optimize with COW) |
| Network | <1KB/min idle | Heartbeat + audit batch |
| File descriptors | <100 per mount | fsnotify watches |

### Benchmarks (targets for CI gate)

```
BenchmarkScopeCheck/simple_path      <100ns
BenchmarkScopeCheck/wildcard_path    <200ns
BenchmarkScopeCheck/deep_nested      <500ns
BenchmarkJWTVerify/cached_key        <50μs
BenchmarkJWTVerify/key_rotation      <100μs
BenchmarkFileSync/small_file         <1ms
BenchmarkFileSync/large_file_1MB     <10ms
BenchmarkMCPProxy/tool_call          <2ms
BenchmarkExecShim/allow              <1ms
BenchmarkExecShim/deny               <500μs
```

---

## Audit Events

### Event Types

Every permission-relevant operation produces an audit event:

```json
{
  "id": "evt_abc123",
  "type": "permission.allowed",
  "timestamp": "2026-03-24T20:15:32.456Z",
  "identity": "dev:khaliq:my-app:coder",
  "session": "sess_xyz789",
  "profile": "coder",
  "project": "my-app",
  "machine": "khaliq-macbook",

  "operation": {
    "plane": "fs",
    "action": "write",
    "target": "/src/api/route.ts",
    "scope_matched": "relayfile:fs:write:/src/*"
  },

  "context": {
    "agent": "claude",
    "workflow": null,
    "step": null,
    "pid": 12345
  }
}
```

### Denied Event (additional fields)

```json
{
  "type": "permission.denied",
  "operation": {
    "plane": "fs",
    "action": "write",
    "target": "/.env.production",
    "scope_matched": null,
    "scopes_held": [
      "relayfile:fs:write:/src/*",
      "relayfile:fs:write:/tests/*"
    ],
    "reason": "no scope covers target path",
    "suggestion": "Add '/.env*' to coder.fs.write if this agent needs env file access"
  }
}
```

### Event Storage

- **Local:** Always written to `.relay/audit.log` (JSONL format, rotated at 10MB)
- **Remote:** Batched upload to `auth.relay.dev/v1/audit/ingest` every 30 seconds
  or 100 events, whichever comes first. Upload is async and non-blocking.
  If upload fails, events accumulate locally until connectivity is restored.
- **Retention:** 90 days on relay.dev, unlimited local

### Dashboard

The relay.dev dashboard provides:
- Real-time permission activity across all projects
- Denial heatmaps (which paths/tools are most denied)
- Agent behavior analysis (which agents hit guardrails most)
- Permission coverage reports (are your profiles too broad or too narrow?)
- Team-wide audit log with search and filter

---

## Security Model

### Trust Boundaries

1. **relayauth** is the root of trust. It issues tokens and publishes JWKS.
2. **The JWT** is the trust carrier. Self-contained, cryptographically signed.
3. **relayfile** (local daemon) trusts the JWT signature, nothing else.
4. **The agent** is untrusted. It cannot modify the mount, the hooks, the
   daemon, or the token. It can only operate within the scoped mount directory.

### Attack Surfaces

| Attack | Mitigation |
|--------|------------|
| Agent modifies .relay/ config | .relay/ is in deny list, not synced to mount |
| Agent kills relay daemon | Daemon runs as separate process, agent doesn't know PID |
| Agent escapes mount directory | Shell aliases PWD; agent has no access to real path |
| Agent modifies git hooks | .git/hooks/ is in deny list for write |
| Agent forges/modifies JWT | JWT is in daemon memory, not in mount filesystem |
| Agent uses symlink to escape | Daemon resolves symlinks before scope check |
| Agent uses hardlink to denied file | Daemon blocks hardlink creation to denied paths |
| Agent uses ../../../ etc path traversal | Daemon canonicalizes all paths before scope check |
| Agent reads /proc/PID/environ for token | Token is not in agent's environment (daemon holds it) |
| Agent makes direct HTTP to MCP server | Network scoping blocks non-proxied connections (phase 2) |
| Token stolen from daemon memory | Token TTL limits exposure; revocation on anomaly |
| JWKS endpoint compromised | Key pinning + certificate transparency monitoring |
| Relay daemon has a bug | Fail-closed: if scope check errors, operation is denied |

### Fail-Closed Design

Every permission check follows fail-closed semantics:
- If scope parsing fails → DENY
- If JWT verification fails → DENY
- If JWKS cache is empty and network is down → DENY (except offline mode)
- If path canonicalization fails → DENY
- If MCP tool matching errors → DENY
- If the daemon crashes → mount becomes read-only (OS-level fallback)

### Token Security

- Tokens are stored in daemon memory only, never written to disk or env vars
- Agent processes receive a mount path, not a token
- Token refresh happens in the daemon, agent is never aware
- Revocation is propagated to JWKS endpoint for cross-machine enforcement
- Short TTL (1 hour default) limits exposure from token theft

---

## Default Permissions (No Config)

When `.relay/permissions.yaml` doesn't exist and `settings.missingConfig` is
`"default"`, the relay daemon uses built-in safe defaults:

```yaml
# Built-in defaults — used when no .relay/permissions.yaml exists
profiles:
  default:
    fs:
      read: ["*"]
      write: ["*"]
      deny:
        - "/.env*"
        - "/.git/config"
        - "/.git/credentials"
        - "/secrets/**"
        - "/**/*.pem"
        - "/**/*.key"
        - "/**/.ssh/**"
        - "/**/credentials*"
        - "/**/.aws/**"
        - "/**/.config/gh/hosts.yml"
    vcs:
      push: ["refs/heads/*"]
      deny:
        - "refs/heads/main"
        - "refs/heads/master"
      forcePush: []
    exec:
      deny:
        - "rm -rf /"
        - "rm -rf ~"
        - "sudo *"
    mcp: []       # all MCP servers unscoped (pass-through)
    network: []   # all network unscoped (pass-through)
```

These defaults protect the 80% case:
- No writing secrets or credentials
- No pushing to main/master
- No force-pushing
- No `rm -rf /` or `sudo`
- Everything else allowed

---

## Phasing

### Phase 1: File + VCS (MVP)
- `.relay/permissions.yaml` configuration
- `relay auth init` project scanner
- `relay shell` hook with sync daemon
- Filesystem scoping (read/write/deny with path patterns)
- VCS scoping (push/force-push with ref patterns)
- Pre-push hook enforcement
- Basic audit logging (local + remote)
- `relay auth check`, `relay auth test`, `relay auth report`
- Default permissions (no config)
- Token lifecycle (mint, refresh, revoke)
- JWT verification with cached JWKS

### Phase 2: Exec + MCP
- Command execution scoping (PATH shim)
- MCP tool proxying with scope enforcement
- MCP tool filtering (hide denied tools from tools/list)
- MCP constraint variables ($REPO, $BRANCH, etc.)
- Cross-repo mounts
- `relay auth suggest` (AI-powered tuning)
- Dashboard on relay.dev

### Phase 3: Network + Advanced
- Network scoping (HTTP proxy)
- Workflow permission inheritance (project ceiling)
- Team permission policies (org-level defaults)
- Permission templates marketplace (community profiles)
- Real-time alerts for anomalous denials
- Integration with CI/CD (enforce in pipelines)
- `relay auth install-hooks` (lightweight git-only mode)

---

## Non-Goals

- **Runtime permission escalation** — agent cannot request more scopes mid-session
- **Interactive permission prompts** — the whole point is to eliminate them
- **Per-file encryption** — this is access control, not data protection
- **Agent behavior modification** — relay doesn't change what agents do, only
  what they CAN do. The agent adapts to boundaries naturally.
- **Replacing OS-level security** — relay adds a layer, doesn't replace
  filesystem permissions, user isolation, or container boundaries
- **DRM / anti-piracy** — not designed to prevent determined human adversaries,
  designed to constrain well-intentioned-but-overpowered AI agents
