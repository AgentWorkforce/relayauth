# RFC: Dot-File Agent Permissions

## Problem

Agents need sandboxed file permissions, but a full YAML config is too much friction for most cases. We need a zero-config interface that devs already understand.

## Proposal

`.gitignore`-style dot files that control what agents can see and do.

### Files

```
.agentignore                  # Files invisible to ALL agents
.agentreadonly                # Files read-only for ALL agents
.code-agent.agentignore       # Files invisible to "code-agent" only
.code-agent.agentreadonly     # Files read-only for "code-agent" only
```

### Rules

- `.gitignore` syntax: globs, `**`, negation with `!`, comments with `#`
- Not in any list → **read/write** (default open)
- In `.agentignore` → **invisible** (doesn't exist to the agent)
- In `.agentreadonly` → **read-only**
- Deny wins: ignore > readonly at the same level
- Per-agent overrides global
- Child directory dot files override parent (cascade, specificity wins)

### Agent Discovery

Agent names come from the dot file names themselves. No YAML required.

```
.agentignore                  → applies to all agents
.code-agent.agentignore       → declares "code-agent" exists
.docs-agent.agentreadonly     → declares "docs-agent" exists
```

`relay scan` discovers agents automatically:

```
$ relay scan
Agents: code-agent, docs-agent (discovered from dot files)

code-agent:
  Ignored:   secrets/, .env, *.pem
  Read-only: README.md, LICENSE
  Read/write: everything else

docs-agent:
  Ignored:   (none)
  Read-only: src/**
  Read/write: docs/, README.md
```

### Example

```gitignore
# .agentignore
.env
.env.*
secrets/
**/*.pem
**/*.key
node_modules/
```

```gitignore
# .agentreadonly
README.md
LICENSE
package-lock.json
go.sum
```

```gitignore
# .code-agent.agentignore
# code-agent also can't touch docs
docs/
```

### UX

The primary interface is the dot files themselves — not a CLI. When an agent
starts working in a project (via Claude Code, Codex, or any relay-connected
runtime), the relay reads the dot files and enforces permissions automatically.
The developer never runs a command. They just commit dot files like they commit
`.gitignore`.

```
# Developer's only action: add dot files to their repo
echo "secrets/\n.env\n*.pem" > .agentignore
echo "README.md\nLICENSE" > .agentreadonly
git add .agentignore .agentreadonly
git commit -m "add agent permissions"
# Done. Every agent that touches this repo is now sandboxed.
```

**Debugging tools** (for devs, not agents):

```bash
relay scan                # preview what each agent can see
relay doctor              # check that the relay runtime is healthy
```

Zero dot files = fully open. One `.agentignore` = sandboxed. No config, no commands.

## Tiers

| Tier | Config | Use case |
|------|--------|----------|
| 0 | Nothing | Fully open (default) |
| 1 | Dot files only | Most users — simple ignore/readonly rules |
| 2 | relay.yaml + dot files | Power users — scoped tokens, RBAC roles, cross-service permissions |

Dot files always apply, even when relay.yaml exists. relay.yaml adds granularity on top.

## Open Questions

1. **Operations control** — should `.agentignore` also restrict commands like `git push origin main` or `cd ~/`? Could use a prefix convention (`!git push`) but adds complexity. Could be a separate `.agentdeny` file for operations.

2. **Directory traversal** — should agents be prevented from accessing `../` or `~/`? Feels like a default-on rule rather than something in dot files.

3. **Cascading depth** — how deep do child-directory overrides go? Proposal: same as `.gitignore` — each directory can have its own dot files, closest wins.

4. **Negation** — `!` in `.agentignore` means "don't ignore this" (re-include). Do we need `!` in `.agentreadonly` to mean "this specific file IS writable even though the parent pattern said readonly"?
