# Prereqs + Dot-file Implementation Review

**Date:** 2026-03-26
**Reviewer:** Non-interactive review agent (Attempt 2)
**Branch:** feat/cloud-preview-dispatch

---

## Verdict: REVIEW_NEEDS_FIXES

The prereq handling, dotfile parser, dotfile compiler, and zero-config integration are all solid and verified via live testing. The e2e test script (`e2e-dotfiles.sh`) has 5 critical bugs that prevent it from executing successfully.

---

## 1. PREREQS (`relay.sh`) — PASS

### `check_prereqs()` (lines 59–102)
- Validates: node, npx, go, wrangler, relayfile binary, D1 state
- Hard failures (missing counter) for critical deps; soft warnings (⚠) for optional state (D1 not initialized, binary not built)
- Wired into `cmd_up` at lines 487–488, before any service startup
- `relay doctor` (lines 751–806) provides comprehensive diagnostics: tools, wrangler, binary, D1, ports 8787/8080, service health

### Health checks (`wait_for_http`, lines 132–149)
- 15 attempts × 2s sleep = 30s total timeout
- Early exit on child process death with log path in error message
- Success message: `"  ✓ ${label} healthy"`
- Failure message includes both URL and log path: `"check logs: .relay/logs/${label}.log"`

### Relayfile binary preference (lines 518–522)
- Checks `-x "${RELAYFILE_ROOT}/bin/relayfile"` first, falls back to `go run ./cmd/relayfile`
- Both paths pass same env vars (`RELAYFILE_JWT_SECRET`, `RELAYFILE_BACKEND_PROFILE`)

### Verification
- `bash -n relay.sh` — syntax OK
- All prereq functions confirmed present and correctly wired

**No issues found in prereqs.**

---

## 2. DOT-FILE PARSER (`dotfile-parser.ts`) — PASS

### .gitignore syntax handling
- Uses the `ignore` npm library — full .gitignore specification support (globs, `**`, negation `!`, comments `#`)
- `cleanPatterns()` strips comments and empty lines for the raw pattern list
- `loadPatterns()` feeds raw content to `ignore.add()` preserving gitignore semantics

### Discovery (`discoverAgents`, lines 40–49)
- Regex `/^\.(.+)\.(agentignore|agentreadonly)$/` correctly matches `.agent-name.agentignore` without matching `..foo.agentignore`
- Returns sorted unique agent names
- `hasDotfiles()` regex at line 36 uses `/^\.[^.].*\.agentignore$/` to exclude `..` prefixed entries

### Precedence / cascading (lines 56–63)
- Global `.agentignore` loads first, per-agent `.{name}.agentignore` layers on top
- Both added to same `ignore()` instance — correct additive behavior
- **Verified live**: code-agent gets global + per-agent patterns; unknown-agent gets only global

### `isIgnored` / `isReadonly` (lines 75–84)
- `isReadonly` returns false for ignored files — deny wins over readonly. Correct.
- Uses `ignore.ignores()` for matching

### CLI guard (line 137)
- `fileURLToPath(import.meta.url)` check prevents execution on import

### Live test results
```
code-agent: ignoredPatterns=["secrets/", ".env", "*.pem", "internal/"], readonlyPatterns=["README.md", "*.lock"]
unknown-agent: ignoredPatterns=["secrets/", ".env", "*.pem"], readonlyPatterns=["README.md", "*.lock"]
```

**No issues found in parser.**

---

## 3. DOT-FILE COMPILER (`dotfile-compiler.ts`) — PASS

### ACL generation (lines 63–113)
- Ignored files → `deny:agent:{name}` rules, grouped by normalized parent directory
- Readonly files → read scope granted, no write scope (enforcement via scope omission)
- Read-write files → both read and write scopes
- `walkProjectFiles` skips `.git` and `.relay` directories

### Scope format (lines 38–41)
- Path-specific scopes: `relayfile:fs:read:/path` and `relayfile:fs:write:/path`
- NOT wildcard scopes — each file gets individual scope entries

### ACL path normalization (lines 24–30)
- `.` → `/`, trailing slashes removed, double slashes collapsed
- Consistent with `parse-config.ts` normalization

### Live test results
```
ignoredPaths: [".env", "internal/config.ts", "secrets/key.pem"]
readonlyPaths: ["README.md"]
readwritePaths: [".agentignore", ".agentreadonly", ".code-agent.agentignore", "package-lock.json", "src/app.ts"]
acl: { "/": ["deny:agent:code-agent"], "/internal": ["deny:agent:code-agent"], "/secrets": ["deny:agent:code-agent"] }
summary: { ignored: 3, readonly: 1, readwrite: 5 }
```

- `package-lock.json` correctly classified as readwrite (`*.lock` pattern doesn't match `.json` extension)
- ACL rules correctly group denied files by parent directory

**No issues found in compiler.**

---

## 4. ZERO-CONFIG (`relay.sh`) — PASS

### Flow: no `relay.yaml` + dotfiles present
- `resolve_effective_config_path()` calls `create_generated_config()` (line 333)
- Discovers agents via `discover_dotfile_agents()`, compiles per-agent permissions
- Generates `.relay/generated/relay-zero-config.json` with compiled scopes and ACL
- If only global dotfiles exist (no per-agent files), creates `default-agent`

### Flow: no `relay.yaml` + no dotfiles
- Creates fully open `default-agent` with `relayfile:*:*:*` scope (lines 304–308)
- Correct for "just works" experience

### Flow: `relay.yaml` present + dotfiles
- Uses relay.yaml directly, applies dotfile ACL overlay during provision (lines 633–643)

### Commands verified
- `relay scan [agent-name]`: shows ignored/readonly pattern summary per agent
- `relay init --dotfiles`: creates sensible defaults
  - `.agentignore`: `.env`, `secrets/`, `*.pem`, `*.key`, `node_modules/`
  - `.agentreadonly`: `README.md`, `LICENSE`, `*.lock`
- Won't overwrite existing files — safe to re-run
- `relay shell <agent>`: prints permission summary on entry (line 688)
- `relay provision`: compiles ACL bundle, seeds it, reports counts

**No issues found in zero-config.**

---

## 5. SECURITY — PASS

- `.agentignore` defaults include `.env`, `secrets/`, `*.pem`, `*.key` — good first-line defense
- `node_modules/` also ignored by default — prevents dependency tampering
- Deny ACL rules use `deny:agent:{name}` — agent-specific, not global
- Readonly enforcement via scope omission (no write scope), not advisory
- `isReadonly` returns false for ignored files — deny wins

**Note:** Default `.agentignore` does not include `.git/`. Agents can read git history. Likely intentional but worth documenting for users.

---

## 6. E2E TEST (`e2e-dotfiles.sh`) — FAIL (5 bugs)

### Bug 1: Top-level `await` in `npx tsx --eval` — BLOCKING
**Lines 145–183 (`run_parser_probe`) and 190–226 (`run_compile_probe`)**

Both probe functions use `npx tsx --eval` with `await import(...)` which is top-level await. tsx's `--eval` mode uses CJS output format, which does not support top-level await.

**Confirmed error:**
```
ERROR: Top-level await is currently not supported with the "cjs" output format
```

**Fix:** Wrap probe body in async IIFE: `(async () => { ... })()` or write to a temp `.mts` file.

### Bug 2: Wrong property name `aclRules` (should be `acl`) — BLOCKING
**Line 216:** `compiled.aclRules` should be `compiled.acl`

The `compileDotfiles()` function returns `{ acl: {...} }`, not `{ aclRules: {...} }`. The probe reads `undefined`, causing all ACL assertions to silently fail.

Line 223: `compiled.deniedPatterns` also doesn't exist on the return type.

### Bug 3: Wrong third argument to `compileDotfiles` — BUG
**Line 210:** `const args = [projectDir, agentName, perms];`

`compileDotfiles(projectDir, agentName, workspace)` expects a workspace **string** as the third argument, but the probe passes the `perms` DotfilePermissions object. The workspace field in output will be `[object Object]`.

**Fix:** `const args = [projectDir, agentName, "e2e-test"];`

### Bug 4: Wildcard scope assertion doesn't match compiler output — BUG
**Line 361:** `assert_array_contains "$compile_json" "data.scopes" "relayfile:fs:read:*"`

The compiler produces path-specific scopes (e.g., `relayfile:fs:read:/README.md`), not wildcard `relayfile:fs:read:*`. This assertion will fail even after Bug 1 is fixed.

Also **line 370:** checks for `allow:scope:relayfile:fs:read:/*` in ACL rules, but the compiler only emits `deny:agent:*` rules — it never produces `allow:scope:*` rules.

**Fix:** Assert on specific expected scopes or use a prefix match.

### Bug 5: Admin-agent override test misunderstands cascading model — BUG
**Lines 378–407:** Creates empty `.admin-agent.agentignore` and `.admin-agent.agentreadonly`, then expects that admin-agent has NO ignore/readonly restrictions (lines 387–389).

However, `parseDotfiles` loads global patterns first, then per-agent patterns additively. Empty per-agent files don't **clear** global patterns — they just add nothing. So admin-agent still inherits global `.agentignore` (secrets/, .env) and `.agentreadonly` (README.md).

**Fix:** Either:
- Change the cascading model to support per-agent overrides (breaking change), or
- Remove this test, or
- Change the assertion to expect that admin-agent inherits global restrictions

---

## 7. ACL SEEDING (`seed-acl.ts`) — PASS

- `--compiled-json` flag accepts compiled ACL bundle from dotfile compiler
- Seeds ACL entries as `.relayfile.acl` files in the relayfile workspace
- Handles both `--config` (relay.yaml) and `--compiled-json` (dotfile-compiled) paths
- Consistent error handling with other scripts

**No issues found.**

---

## Summary Table

| Component | Status | Notes |
|-----------|--------|-------|
| Prereqs (`check_prereqs`, `doctor`) | PASS | Comprehensive checks, clear messages |
| Dotfile parser | PASS | Full .gitignore semantics via `ignore` lib |
| Dotfile compiler | PASS | Correct ACL/scope generation, verified live |
| Zero-config mode | PASS | Solid 3-mode fallback chain |
| `relay scan` / `init` / `shell` | PASS | Good UX |
| Security defaults | PASS | Sensible .agentignore defaults |
| E2E test | **FAIL** | 5 bugs prevent successful execution |
| ACL seeding | PASS | `--compiled-json` integration works |

---

## Required Fixes (priority order)

1. **e2e-dotfiles.sh**: Fix top-level `await` in `npx tsx --eval` — wrap in async IIFE
2. **e2e-dotfiles.sh**: Fix `compiled.aclRules` → `compiled.acl` in compiler probe
3. **e2e-dotfiles.sh**: Pass workspace string instead of `perms` object to `compileDotfiles`
4. **e2e-dotfiles.sh**: Fix scope assertions to match path-specific scopes (not wildcards)
5. **e2e-dotfiles.sh**: Fix admin-agent override test to match actual cascading behavior

---

REVIEW_NEEDS_FIXES
