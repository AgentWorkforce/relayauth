# Trajectory: Refactor OSS relayauth to remove Cloudflare-specific code

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 28, 2026 at 06:19 PM
> **Completed:** March 28, 2026 at 06:33 PM

---

## Summary

Removed Cloudflare-specific OSS server code, introduced a plain Node Hono server entrypoint, rewrote the OSS storage package to use the existing better-sqlite3 backend directly, updated local scripts/package metadata away from Wrangler, and verified the workspace build plus /health startup path.

**Approach:** Standard approach

---

## Key Decisions

### Collapse sqlite.ts to pure Node SQLite and move createApp to server.ts while keeping @relayauth/server createApp export stable
- **Chose:** Collapse sqlite.ts to pure Node SQLite and move createApp to server.ts while keeping @relayauth/server createApp export stable
- **Reasoning:** The repo already has a working better-sqlite3-backed implementation under a Cloudflare compatibility layer, so removing the facade is safer than rewriting the storage behavior from scratch.

---

## Chapters

### 1. Work
*Agent: default*

- Collapse sqlite.ts to pure Node SQLite and move createApp to server.ts while keeping @relayauth/server createApp export stable: Collapse sqlite.ts to pure Node SQLite and move createApp to server.ts while keeping @relayauth/server createApp export stable
- Cloudflare worker entrypoints and D1/DO/KV shims were removed from OSS, the existing Node SQLite backend was promoted to the primary storage path, and the package now boots through a plain Hono node server entrypoint.
