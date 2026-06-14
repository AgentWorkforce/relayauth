# Trajectory: Work on the relay — e2e validated

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 27, 2026 at 12:40 PM
> **Completed:** March 27, 2026 at 12:40 PM

---

## Summary

Work on the relay is functional end-to-end. Codex tested successfully in sandboxed workspace. secrets/ and .env invisible, README.md read-only, src/ writable. All enforced via relayauth tokens + relayfile ACLs + mount client filtering.

**Approach:** Standard approach

---

## Key Decisions

### Full e2e validated: .agentignore hides files, .agentreadonly enforces chmod 444, path-aware scopes deny .env at HTTP and mount level, codex runs on the relay with --dangerously-bypass-approvals-and-sandbox
- **Chose:** Full e2e validated: .agentignore hides files, .agentreadonly enforces chmod 444, path-aware scopes deny .env at HTTP and mount level, codex runs on the relay with --dangerously-bypass-approvals-and-sandbox
- **Reasoning:** All permission layers working: dotfile compiler, token scoping, server-side ACL enforcement, mount client filtering, fsnotify change detection, readonly revert

---

## Chapters

### 1. Work
*Agent: default*

- Full e2e validated: .agentignore hides files, .agentreadonly enforces chmod 444, path-aware scopes deny .env at HTTP and mount level, codex runs on the relay with --dangerously-bypass-approvals-and-sandbox: Full e2e validated: .agentignore hides files, .agentreadonly enforces chmod 444, path-aware scopes deny .env at HTTP and mount level, codex runs on the relay with --dangerously-bypass-approvals-and-sandbox
