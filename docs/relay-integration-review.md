# Relay Integration Review

**Date:** 2026-03-26
**Reviewer:** Non-interactive review agent
**Scope:** All "work on the relay" implementation across relayauth

---

## 1. JWT Compatibility

**Verdict: PASS**

`generate-dev-token.sh` (line 18) now emits both `wks` and `workspace_id` (same value), plus `agent_name` (defaults to `sub`). The `aud` array defaults to `["relayauth","relayfile"]`. This matches Option A from the spec exactly.

`RelayAuthTokenClaims` in `packages/types/src/token.ts` adds optional `workspace_id` and `agent_name` fields — backwards-compatible, no breaking changes.

`test-helpers.ts` (`generateTestToken`) populates `workspace_id` and `agent_name` with sensible defaults, and the scope-middleware test at line 293+ verifies these claims are round-tripped through the middleware.

**No issues.**

---

## 2. Scope Alignment

**Verdict: PASS**

`parse-config.ts` imports `parseScope` from `packages/sdk/typescript/src/scope-parser.ts` and validates every scope in `relay.yaml` against the canonical `plane:resource:action:path` format. The `normalizeScope` function (line 60) canonicalizes wildcards to `*:*:*:*`.

The scope parser validates planes (`relaycast`, `relayfile`, `cloud`, `relayauth`), actions, and filesystem path rules (POSIX paths, trailing `/*` wildcards only, no `..`). This is the same parser used server-side, so relay.yaml scopes are guaranteed to be valid relayauth scopes.

**No issues.**

---

## 3. ACL Enforcement

**Verdict: PASS**

`seed-acl.ts` writes `.relayfile.acl` marker files via PUT to relayfile's filesystem API. The ACL format is `{ semantics: { permissions: [...rules] } }` which matches what the e2e test uses (line 312 of e2e-test.sh).

Root ACL path `/` maps to `/.relayfile.acl`; nested paths like `/secrets` map to `/secrets/.relayfile.acl`. This matches the relayfile ancestor-walk convention.

ACL rules reference relayauth scopes (e.g., `allow:scope:relayfile:fs:read:/secrets/*`) and agent names (`deny:agent:test-reader`), which are the formats relayfile expects.

**No issues.**

---

## 4. CLI Completeness

**Verdict: PASS**

`relay.sh` implements all 8 commands from the spec:

| Spec Command | Implemented | Notes |
|---|---|---|
| `relay init` | Yes (line 155) | Parses relay.yaml, prints summary |
| `relay up` | Yes (line 178) | Starts both services, waits for health |
| `relay down` | Yes (line 247) | Graceful TERM then KILL fallback |
| `relay provision` | Yes (line 260) | Creates identities, issues tokens, seeds ACLs |
| `relay shell <agent>` | Yes (line 322) | Exports env vars, execs $SHELL |
| `relay token <agent>` | Yes (line 343) | Prints stored JWT |
| `relay mount <agent> <dir>` | Yes (line 350) | Delegates to relayfile-mount binary |
| `relay status` | Yes (line 368) | Health checks + PID status + token presence |

The `provision` flow matches the spec: create identity -> issue token -> store in `.relay/tokens/<name>.jwt` -> seed ACLs. The `up` command does NOT auto-provision (spec says it should run `relay provision` at step 6).

**Minor issue:** `relay up` does not call `relay provision` automatically as the spec describes. This is non-blocking since users can run `relay provision` separately, but it's a deviation from spec.

**One concern:** `relay.sh` line 4 hardcodes absolute paths:
```bash
RELAYAUTH_ROOT="/Users/khaliqgant/Projects/AgentWorkforce/relayauth"
RELAYFILE_ROOT="/Users/khaliqgant/Projects/AgentWorkforce/relayfile"
```
This only works on your machine. Should use `SCRIPT_DIR` derivation or env var overrides.

---

## 5. E2E Coverage

**Verdict: PASS**

The e2e test script covers four key permission scenarios:

| Scenario | Expected | Line |
|---|---|---|
| Reader GET /src/hello.ts | 200 (allowed) | 316 |
| Reader GET /secrets/key.pem | 403 (ACL deny) | 317 |
| Reader PUT /src/hello.ts | 403 (no write scope) | 321 |
| Writer GET /src/hello.ts | 200 (allowed) | 324 |
| Writer PUT /src/hello.ts | 200 (write scope match) | 330 |
| Writer PUT /secrets/key.pem | 403 (no write to /secrets) | 331 |

This covers read-allowed, read-denied (ACL), write-denied (no scope), write-allowed, and write-denied (wrong path). Good coverage of the permission matrix.

The test is self-contained: starts services, generates tokens, provisions identities, seeds files and ACLs, runs assertions, cleans up. Exit code reflects pass/fail.

**No blocking issues.**

---

## 6. Security

**Verdict: PASS (for local dev)**

- `SHARED_SECRET` in e2e-test.sh is hardcoded to `"e2e-test-secret"` — acceptable for a test script that's never deployed.
- `generate-dev-token.sh` defaults to `"dev-secret"` but accepts `SIGNING_KEY` from env — no real secrets in source.
- `.relay/` directory (where tokens are stored) is not in `.gitignore`. Tokens contain JWTs with scopes.
- `relay.yaml` contains `signing_secret` in plaintext — acceptable for local dev per the spec, but should never be committed with real secrets.

**Minor issue:** `.relay/` should be added to `.gitignore` to prevent accidental commit of generated tokens.

---

## Summary of Issues

### Non-blocking (recommended fixes)

1. **`.relay/` not in `.gitignore`** — Add `.relay/` to `.gitignore` to prevent token files from being committed.
   ```
   echo ".relay/" >> .gitignore
   ```

2. **Hardcoded paths in `relay.sh`** — Lines 4-5 hardcode `/Users/khaliqgant/...`. Replace with:
   ```bash
   RELAYAUTH_ROOT="${RELAYAUTH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
   RELAYFILE_ROOT="${RELAYFILE_ROOT:-$(cd "${RELAYAUTH_ROOT}/../relayfile" 2>/dev/null && pwd || true)}"
   ```

3. **`relay up` doesn't auto-provision** — The spec says step 6 of `relay up` should run `relay provision`. Consider adding `cmd_provision` at the end of `cmd_up`.

### No blocking issues found

All six review criteria pass. The JWT claim mapping is correct, scopes are validated against the canonical parser, ACL seeding produces the right format, the CLI covers all spec commands, the e2e test exercises the permission matrix, and secret handling is appropriate for local dev.

---

## REVIEW_APPROVED
