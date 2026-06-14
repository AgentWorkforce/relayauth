# Trajectory: Execute SDK reorganization

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** March 28, 2026 at 04:46 PM
> **Completed:** March 28, 2026 at 04:57 PM

---

## Summary

Reorganized the SDKs under packages/sdk/{typescript,python}, updated workspace/path references, added a contract parity check and PR workflow, and validated npm typecheck/build plus relocated Python tests.

**Approach:** Standard approach

---

## Key Decisions

### Use nested npm workspaces for packages/sdk/{typescript,python} and keep package names/module names stable
- **Chose:** Use nested npm workspaces for packages/sdk/{typescript,python} and keep package names/module names stable
- **Reasoning:** Reorganization should align directory structure with relayfile without changing import paths or published package identities.

---

## Chapters

### 1. Work
*Agent: default*

- Use nested npm workspaces for packages/sdk/{typescript,python} and keep package names/module names stable: Use nested npm workspaces for packages/sdk/{typescript,python} and keep package names/module names stable
- SDKs moved into packages/sdk/{typescript,python}; remaining work is contract gating, path cleanup, and validation.
