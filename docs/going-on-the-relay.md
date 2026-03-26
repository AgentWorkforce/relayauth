# Going On The Relay

## Quick Start (zero config)

No `relay.yaml` needed. The relay discovers agents and permissions from dotfiles alone.

### 1. Create `.agentignore` in your project root

```
secrets/
.env
*.pem
credentials/
```

Files matching these patterns are **denied** to all agents.

### 2. Create `.agentreadonly`

```
README.md
LICENSE
*.lock
package.json
```

Files matching these patterns are **read-only** for all agents. If a path matches both ignore and readonly, ignore wins.

### 3. (Optional) Per-agent overrides

Create agent-specific dotfiles by naming them `.{agent}.agentignore` or `.{agent}.agentreadonly`:

```
# .claude.agentignore — extra restrictions just for claude
internal-docs/

# .coder.agentreadonly — extra readonly paths just for coder
src/config/*.ts
```

Agent names are auto-discovered from these filenames.

### 4. Start the relay

```bash
source scripts/relay/relay.sh
relay up
relay shell default-agent
```

You're on the relay. Permission-checked file access is active. If dotfiles defined agent names (e.g., `.claude.agentignore`), use that name instead:

```bash
relay shell claude
```

### 5. Preview permissions before starting

```bash
relay scan            # show permissions for all discovered agents
relay scan claude     # show permissions for a specific agent
```

Output shows ignored patterns, readonly patterns, and everything else as read/write.

## With relay.yaml (power users)

For full control, create a `relay.yaml` in your project root:

```yaml
agents:
  - name: claude
    scopes:
      - "read:file:/src/**"
      - "write:file:/src/**"
      - "deny:file:/src/config/secrets.ts"

  - name: coder
    scopes:
      - "read:file:/**"
      - "write:file:/src/**"
```

When `relay.yaml` is present, it takes precedence. Dotfile patterns are still compiled into ACL rules and merged.

```bash
relay init                # scaffold a relay.yaml from current dotfiles
relay init --dotfiles     # create starter .agentignore and .agentreadonly files
relay up                  # start services (builds relayfile + D1 if needed)
relay shell claude        # enter scoped shell for the claude agent
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `relay up` | Start services (auto-builds dependencies if needed) |
| `relay down` | Stop all relay services |
| `relay shell <agent>` | Enter a permission-scoped shell for the named agent |
| `relay scan [agent]` | Preview effective permissions (all agents or one) |
| `relay doctor` | Check prerequisites (node, go, wrangler, relayfile, D1) |
| `relay init` | Scaffold a `relay.yaml` from current project state |
| `relay init --dotfiles` | Create starter `.agentignore` and `.agentreadonly` files |
| `relay status` | Show running services and current state |
| `relay token <agent>` | Generate a scoped token for an agent |
| `relay provision` | Seed the ACL database from config |
| `relay mount` | Mount the FUSE filesystem for file-level enforcement |

## Prerequisites

The relay checks for these automatically (`relay doctor`):

- **Node.js** and **npx** — runs the dotfile parser/compiler and config tools
- **Go** — builds the relayfile binary (falls back to `go run` if not pre-built)
- **Wrangler** (via npx) — manages the D1 database for ACL storage
- **relayfile repo** — cloned alongside relayauth (auto-detected)

All checks are soft warnings except Node, which is required. The relay degrades gracefully when optional tools are missing.

## How It Works

1. **Dotfile parsing** — `.agentignore` and `.agentreadonly` files are read using gitignore-style pattern matching
2. **ACL compilation** — Patterns are compiled into `deny:agent:X` and `read:agent:X` rules keyed by directory path
3. **Token scoping** — Each agent gets a JWT with only its permitted scopes
4. **File enforcement** — The relayfile FUSE mount checks the token's scopes on every file operation
