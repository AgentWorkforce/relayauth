# Trajectory: Permission enforcement hardening

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** March 27, 2026 at 12:21 PM
> **Completed:** March 27, 2026 at 12:21 PM

---

## Summary

Added fsnotify, path-aware scopes, canReadPath, agentdeny, readonly revert, and full test coverage. All tests passing.

**Approach:** Standard approach

---

## Key Decisions

### fsnotify replaces polling for instant local change detection
- **Chose:** fsnotify replaces polling for instant local change detection
- **Reasoning:** Polling had 2-second delay. fsnotify uses OS-level notifications (inotify/FSEvents) for instant push. WebSocket handles pull. Polling kept as 30s reconciliation fallback.

### Path-aware scope matching fixes .env leak
- **Chose:** Path-aware scope matching fixes .env leak
- **Reasoning:** scopeMatches was ignoring the path segment — token with relayfile:fs:read:/src/app.ts was granting read to all files including .env. scopeMatchesPath now checks path prefix matching.

### .agentdeny command filter via shell preexec hook
- **Chose:** .agentdeny command filter via shell preexec hook
- **Reasoning:** Prevents operations like git push, sudo, rm -rf. Uses bash trap DEBUG and zsh preexec. Pattern matching against .agentdeny file.

---

## Chapters

### 1. Work
*Agent: default*

- fsnotify replaces polling for instant local change detection: fsnotify replaces polling for instant local change detection
- Path-aware scope matching fixes .env leak: Path-aware scope matching fixes .env leak
- .agentdeny command filter via shell preexec hook: .agentdeny command filter via shell preexec hook
