# Trajectory: Work on the relay: combine relayauth + relayfile for agent sandboxing with dotfile permissions

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** March 26, 2026 at 10:51 PM
> **Completed:** March 26, 2026 at 11:20 PM

---

## Summary

Added managed relay mount lifecycle commands and a shell e2e covering registry, targeted unmount, and relay down cleanup.

**Approach:** Standard approach

---

## Key Decisions

### JWT claim mapping: relayauth adds workspace_id and agent_name to tokens for relayfile compatibility
- **Chose:** JWT claim mapping: relayauth adds workspace_id and agent_name to tokens for relayfile compatibility
- **Reasoning:** relayfile auth.go expects workspace_id and agent_name claims. Adding aliases in relayauth (2 lines) is simpler than changing relayfile. Zero changes to relayfile needed.

### Dotfile permission model: .agentignore/.agentreadonly with .gitignore syntax
- **Chose:** Dotfile permission model: .agentignore/.agentreadonly with .gitignore syntax
- **Reasoning:** Will Washburn proposed simple on/off via dot files. Agent names discovered from filenames (.code-agent.agentignore declares code-agent). Zero config for 80% case, relay.yaml for power users. Cascade: per-agent overrides global, deny wins.

### FUSE mount as local enforcement mechanism over kernel sandboxing, MCP, or LD_PRELOAD
- **Chose:** FUSE mount as local enforcement mechanism over kernel sandboxing, MCP, or LD_PRELOAD
- **Reasoning:** Evaluated Landlock (cant hide files, stat still works), macOS sandbox-exec (deprecated), MCP (doesnt enforce, agent still has built-in file tools), LD_PRELOAD (Go bypasses libc). FUSE wins: transparent, kernel-level, any agent works, no wrapping needed. Per-agent mount avoids concurrency bottleneck.

### OSS vs Cloud split: local free, distributed paid. @relayauth/core bridges both
- **Chose:** OSS vs Cloud split: local free, distributed paid. @relayauth/core bridges both
- **Reasoning:** Local dev sandboxing is the free adoption play (like git). Cloud coordination is the paid platform (like GitHub). Core package (token verify, scope parsing, ACL eval) is OSS with zero deps. Cloud imports it and adds multi-tenancy, billing, edge deployment, credential management.

### Dedup cloud/relayauth — currently a byte-for-byte copy of OSS, must import from @relayauth/core instead
- **Chose:** Dedup cloud/relayauth — currently a byte-for-byte copy of OSS, must import from @relayauth/core instead
- **Reasoning:** cloud/packages/relayauth has 26 identical source files copied from OSS relayauth/packages/server. Will drift. cloud/relayfile already does it right (thin proxy importing from @relayfile/core). cloud/relayauth must follow same pattern: import core logic, add only cloud-specific wrappers.

### Distributed agents use relayfile HTTP API directly, not FUSE. FUSE is local-only convenience.
- **Chose:** Distributed agents use relayfile HTTP API directly, not FUSE. FUSE is local-only convenience.
- **Reasoning:** In production and cross-machine scenarios, agents talk to relayfile via HTTPS (SDK/AI adapters). Concurrency handled server-side (optimistic locking with If-Match). WebSocket push for real-time sync. FUSE only makes sense for local dev where the agent needs a normal filesystem interface.

### Implement relay mount lifecycle with .relay/mounts.json registry and explicit mounts/unmount commands
- **Chose:** Implement relay mount lifecycle with .relay/mounts.json registry and explicit mounts/unmount commands
- **Reasoning:** The existing mount command execs a foreground process and cannot be managed or cleaned up. The workflow requires tracked background mounts plus cleanup on relay down.

### Implemented relay run as a self-contained agent launcher in relay.sh
- **Chose:** Implemented relay run as a self-contained agent launcher in relay.sh
- **Reasoning:** This worker only owns cmd_run, so the command provisions tokens, syncs a per-agent workspace mirror, launches the agent CLI with relay env vars, and performs local cleanup without introducing lifecycle subcommands owned by the other worker

### Promoted relay config parsing and ACL seeding into @relayauth/core
- **Chose:** Promoted relay config parsing and ACL seeding into @relayauth/core
- **Reasoning:** The repo already had working script-level implementations in scripts/relay; packaging them under packages/core creates a reusable workspace module for the relay sandbox flow while keeping the CLI scripts as thin wrappers.

---

## Chapters

### 1. Work
*Agent: default*

- JWT claim mapping: relayauth adds workspace_id and agent_name to tokens for relayfile compatibility: JWT claim mapping: relayauth adds workspace_id and agent_name to tokens for relayfile compatibility
- Dotfile permission model: .agentignore/.agentreadonly with .gitignore syntax: Dotfile permission model: .agentignore/.agentreadonly with .gitignore syntax
- FUSE mount as local enforcement mechanism over kernel sandboxing, MCP, or LD_PRELOAD: FUSE mount as local enforcement mechanism over kernel sandboxing, MCP, or LD_PRELOAD
- OSS vs Cloud split: local free, distributed paid. @relayauth/core bridges both: OSS vs Cloud split: local free, distributed paid. @relayauth/core bridges both
- Dedup cloud/relayauth — currently a byte-for-byte copy of OSS, must import from @relayauth/core instead: Dedup cloud/relayauth — currently a byte-for-byte copy of OSS, must import from @relayauth/core instead
- Distributed agents use relayfile HTTP API directly, not FUSE. FUSE is local-only convenience.: Distributed agents use relayfile HTTP API directly, not FUSE. FUSE is local-only convenience.
- Extensive design session covering full relay vision. Spec, RFC, 6 workflows written and validated. Core architecture settled: dotfiles for UX, FUSE for local enforcement, HTTP API for distributed, @relayauth/core as shared package. Key discovery: cloud/relayauth is a full duplicate of OSS that needs dedup. Workflows ready to execute: fuse-mount (relayfile), relay-run (relayauth), distributed-relay-access (cloud). Also fixed relay.sh bugs (zsh status var, source exit, port conflicts) during live testing.
- Implement relay mount lifecycle with .relay/mounts.json registry and explicit mounts/unmount commands: Implement relay mount lifecycle with .relay/mounts.json registry and explicit mounts/unmount commands
- Implemented relay run as a self-contained agent launcher in relay.sh: Implemented relay run as a self-contained agent launcher in relay.sh
- Promoted relay config parsing and ACL seeding into @relayauth/core: Promoted relay config parsing and ACL seeding into @relayauth/core
- Mount lifecycle management is now tracked through a persistent registry and validated by a stubbed e2e. The implementation cleans up targeted mounts and down-path leftovers without requiring a live relay stack.

---

## Artifacts

**Files changed:** 1
