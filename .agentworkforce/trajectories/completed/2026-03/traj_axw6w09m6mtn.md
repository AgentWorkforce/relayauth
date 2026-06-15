# Trajectory: Write tests verifying the package exports and app factory

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 27, 2026 at 08:08 PM
> **Completed:** March 27, 2026 at 08:12 PM

---

## Summary

Added node:test coverage for createApp(), route registration, barrel exports, and app factory idempotence; also exported createApp from the server index and scoped bridge rate limiting per app instance.

**Approach:** Standard approach

---

## Key Decisions

### Added createApp() in worker.ts and re-exported it from the server index while preserving the default app singleton
- **Chose:** Added createApp() in worker.ts and re-exported it from the server index while preserving the default app singleton
- **Reasoning:** The requested tests target a factory API that does not exist yet; exporting a factory keeps current singleton consumers working and gives tests a stable way to verify route registration and instance isolation.

---

## Chapters

### 1. Work
*Agent: default*

- Added createApp() in worker.ts and re-exported it from the server index while preserving the default app singleton: Added createApp() in worker.ts and re-exported it from the server index while preserving the default app singleton
