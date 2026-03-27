# Trajectory: Fix SQLite identity storage to pass identity-related tests

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** March 27, 2026 at 10:32 PM
> **Completed:** March 27, 2026 at 10:37 PM

---

## Summary

Updated SQLite identity storage in packages/server/src/storage/sqlite.ts to generate missing IDs, preserve full StoredIdentity fields, deep-merge metadata, apply budget auto-suspension with transition-based audit writes, and keep suspend/reactivate/retire lifecycle changes independent from budget re-evaluation.

**Approach:** Standard approach

---

## Key Decisions

### Aligned SQLite identity storage with IdentityDO semantics for budget auto-suspension and lifecycle updates
- **Chose:** Aligned SQLite identity storage with IdentityDO semantics for budget auto-suspension and lifecycle updates
- **Reasoning:** create/update now detect budget_exceeded transitions for audit writes, while suspend/reactivate/retire bypass generic update so manual lifecycle actions are not re-written by budget policy.

---

## Chapters

### 1. Work
*Agent: default*

- Aligned SQLite identity storage with IdentityDO semantics for budget auto-suspension and lifecycle updates: Aligned SQLite identity storage with IdentityDO semantics for budget auto-suspension and lifecycle updates
- SQLite identity storage now matches IdentityDO for create/update budget handling and lifecycle state changes; the broader requested test command is still blocked by unrelated fixture/test issues outside sqlite identity storage.
