# Prereqs & Dot-File Permissions Design

## Part 1: Prerequisites — Making `relay up` Just Work

### Goal

Running `relay up` should handle all setup automatically: build binaries, migrate databases, bootstrap tokens, and verify services — no manual steps.

### 1.1 Check & Build Relayfile Binaries

**When:** At the start of `cmd_up`, before launching services.

```bash
ensure_relayfile_binaries() {
  local server_bin="${RELAYFILE_ROOT}/bin/relayfile-server"
  local mount_bin="${RELAYFILE_ROOT}/bin/relayfile-mount"

  if [[ -x "${server_bin}" && -x "${mount_bin}" ]]; then
    return 0
  fi

  echo "Building relayfile binaries..."
  (cd "${RELAYFILE_ROOT}" && make build) || error "failed to build relayfile"

  [[ -x "${server_bin}" ]] || error "relayfile-server binary not found after build"
  [[ -x "${mount_bin}" ]] || error "relayfile-mount binary not found after build"
}
```

**Change to `cmd_up`:** Replace `go run ./cmd/relayfile` with direct binary execution:

```bash
# Before (compiles on every run):
RELAYFILE_JWT_SECRET="${secret}" go run ./cmd/relayfile > "${relayfile_log}" 2>&1

# After (uses pre-built binary):
RELAYFILE_JWT_SECRET="${secret}" RELAYFILE_BACKEND_PROFILE=durable-local \
  "${RELAYFILE_ROOT}/bin/relayfile-server" > "${relayfile_log}" 2>&1
```

This is faster (no compile step on each `relay up`) and ensures the mount binary is also available for `relay mount`.

### 1.2 Seed D1 Database (First-Run Detection)

**When:** After building binaries, before starting relayauth.

```bash
ensure_d1_migrated() {
  local state_dir="${RELAYAUTH_ROOT}/.wrangler/state"
  if [[ -d "${state_dir}" ]]; then
    return 0  # Already migrated
  fi

  echo "Running D1 migrations (first run)..."
  (cd "${RELAYAUTH_ROOT}" && npx wrangler d1 migrations apply relayauth --local) \
    || error "D1 migration failed"
}
```

**Why first-run only:** The `.wrangler/state` directory is created by wrangler on first use. If it exists, migrations have already been applied. Wrangler dev also auto-applies pending migrations on startup, so this is a safety net for the initial bootstrap.

**Edge case:** If the user deletes `.wrangler/state`, the next `relay up` will re-run migrations. This is fine — the migration SQL is idempotent (`CREATE TABLE IF NOT EXISTS` pattern in `0001_local_bootstrap.sql`).

### 1.3 Admin Token Bootstrap (Documented)

The chicken-and-egg problem is already solved. Documenting the approach clearly:

**Problem:** We need a Bearer token to call relayauth's `/v1/identities` and `/v1/tokens` APIs during provisioning, but those APIs are what issue tokens.

**Solution:** `generate-dev-token.sh` creates an HS256 JWT locally using the shared `SIGNING_KEY` — no API call needed. The token is valid because relayauth validates JWTs against the same `SIGNING_KEY`. This is the same signing approach relayauth uses internally.

**The existing `generate_admin_token()` function in relay.sh is correct.** It sets:
- `RELAYAUTH_SUB=relay-admin`
- `RELAYAUTH_SCOPES_JSON='["relayauth:*:manage:*","relayauth:*:read:*","relayfile:*:*:*"]'`
- `RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]'`

This grants the admin token full access to both services. No changes needed here.

### 1.4 Service Health Checks

The existing `wait_for_http` function uses up to 60 retries (60 seconds). Update to:

```bash
wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-30}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "${label} is healthy"
      return 0
    fi
    if ! service_alive "${!label_pid_var}"; then
      error "${label} process exited unexpectedly; check .relay/logs/${label}.log"
    fi
    sleep 1
  done
  error "${label} did not become healthy at ${url} after ${attempts}s; check .relay/logs/${label}.log"
}
```

**Key improvement:** Check if the process is still alive during the wait loop. If the process crashed, fail immediately with a pointer to the log file instead of waiting the full timeout.

### 1.5 Relayfile `aud` Claim Verification

**Current behavior in `auth.go` `parseBearer()`:**

```go
if !hasAudience(payload["aud"], "relayfile") {
    return tokenClaims{}, &authError{...}
}
```

**`hasAudience()` correctly handles arrays:**

```go
case []any:
    for _, item := range typed {
        if aud, ok := item.(string); ok && strings.TrimSpace(aud) == required {
            return true
        }
    }
```

**Verdict: No change needed.** The `hasAudience` function already handles:
- Single string `"relayfile"` → matches
- Array `["relayauth", "relayfile"]` → iterates and matches
- Array of `[]any` (which is what `json.Unmarshal` into `map[string]any` produces) → handled

The `generate-dev-token.sh` outputs `"aud":["relayauth","relayfile"]`, which Go's `json.Unmarshal` decodes as `[]any{string, string}`. This matches the `[]any` case in `hasAudience`. **Confirmed working.**

### 1.6 Updated `cmd_up` Flow

```
cmd_up:
  1. parse_config_json + write_config_cache
  2. ensure_state_dirs
  3. ensure_relayfile_binaries          ← NEW
  4. ensure_d1_migrated                 ← NEW
  5. Check for stale .relay/pids
  6. Start relayauth (wrangler dev)
  7. Start relayfile (binary, not go run) ← CHANGED
  8. Write .relay/pids
  9. wait_for_http relayauth             ← IMPROVED error msgs
  10. wait_for_http relayfile
  11. Print success
```

After `relay up`, the user runs `relay provision` separately (unchanged). This keeps the commands composable — `relay up` handles infrastructure, `relay provision` handles identity/token setup.

---

## Part 2: Dot-File Permission Model

### Goal

Drop `.agentignore` and `.agentreadonly` files in your project (`.gitignore` syntax). Agents automatically get restricted permissions — no `relay.yaml` needed.

### 2.1 Parser Module: `dotfile-parser.ts`

**Location:** `/scripts/relay/dotfile-parser.ts`

```typescript
import ignore, { type Ignore } from "ignore";  // npm: ignore (same lib as .gitignore)
import fs from "node:fs";
import path from "node:path";

export interface DotfilePermissions {
  /** Glob patterns the agent cannot see at all */
  ignored: Ignore;
  /** Glob patterns the agent can read but not write */
  readonly: Ignore;
}

/**
 * Parse dot-file permissions for a given agent.
 *
 * Reads (in order, later overrides earlier):
 *   1. .agentignore           — global ignore
 *   2. .{agentName}.agentignore — per-agent ignore
 *   3. .agentreadonly         — global readonly
 *   4. .{agentName}.agentreadonly — per-agent readonly
 *
 * Supports full .gitignore syntax via the "ignore" npm package:
 *   - Globs: *.pem, secrets/
 *   - Double-star: **/*.key
 *   - Negation: !important.pem
 *   - Comments: # this is a comment
 */
export function parseDotfiles(
  projectDir: string,
  agentName: string,
): DotfilePermissions {
  const ignoredIg = ignore();
  const readonlyIg = ignore();

  // Global files
  loadPatterns(ignoredIg, path.join(projectDir, ".agentignore"));
  loadPatterns(readonlyIg, path.join(projectDir, ".agentreadonly"));

  // Per-agent files (override global via negation patterns)
  loadPatterns(ignoredIg, path.join(projectDir, `.${agentName}.agentignore`));
  loadPatterns(readonlyIg, path.join(projectDir, `.${agentName}.agentreadonly`));

  return { ignored: ignoredIg, readonly: readonlyIg };
}

function loadPatterns(ig: Ignore, filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  ig.add(content);
}

/**
 * Check if a relative path is ignored for this agent.
 */
export function isIgnored(perms: DotfilePermissions, relativePath: string): boolean {
  return perms.ignored.ignores(relativePath);
}

/**
 * Check if a relative path is read-only for this agent.
 * Note: ignored paths take precedence (deny wins).
 */
export function isReadonly(perms: DotfilePermissions, relativePath: string): boolean {
  if (perms.ignored.ignores(relativePath)) return false; // not readonly — it's invisible
  return perms.readonly.ignores(relativePath);
}
```

**Dependencies:** `ignore` npm package (MIT, same package that powers `.gitignore` in tools like eslint, prettier, etc.)

**Cascading behavior:** The `ignore` package handles negation natively. Per-agent files are loaded after global files, so a per-agent `!secrets/` would un-ignore what the global `.agentignore` hid. The `ignore` package processes rules in order — last match wins for negation.

### 2.2 Compiler Module: `dotfile-compiler.ts`

**Location:** `/scripts/relay/dotfile-compiler.ts`

```typescript
import type { DotfilePermissions } from "./dotfile-parser.ts";
import fs from "node:fs";
import path from "node:path";

export interface CompiledDotfiles {
  /** Map of directory path → ACL rules for .relayfile.acl markers */
  aclRules: Map<string, string[]>;
  /** Scopes to include in the agent's JWT */
  scopes: string[];
  /** Scopes to explicitly EXCLUDE (informational) */
  deniedPatterns: string[];
}

/**
 * Compile parsed dot-file permissions into relayfile-compatible ACL rules and scopes.
 *
 * Strategy:
 *   1. Walk the project directory tree
 *   2. For each file/directory, check against ignore and readonly matchers
 *   3. Ignored → deny:agent:{agentName} ACL rule on the parent directory
 *   4. Readonly → allow only read scope, deny write via ACL
 *   5. Everything else → full read+write access
 */
export function compileDotfiles(
  projectDir: string,
  agentName: string,
  perms: DotfilePermissions,
  workspace: string,
): CompiledDotfiles {
  const aclRules = new Map<string, string[]>();
  const deniedPatterns: string[] = [];

  // Walk directory tree and classify each path
  walkDir(projectDir, projectDir, (relativePath, isDirectory) => {
    if (perms.ignored.ignores(relativePath)) {
      // Ignored: agent can't see this at all
      const dir = isDirectory ? `/${relativePath}` : `/${path.dirname(relativePath)}`;
      const normalizedDir = dir === "/." ? "/" : dir;
      appendRule(aclRules, normalizedDir, `deny:agent:${agentName}`);
      deniedPatterns.push(relativePath);
    } else if (perms.readonly.ignores(relativePath)) {
      // Readonly: agent can read but not write
      const dir = isDirectory ? `/${relativePath}` : `/${path.dirname(relativePath)}`;
      const normalizedDir = dir === "/." ? "/" : dir;
      // Add a scope-based ACL that only allows read
      // The agent's token won't have write scope for this path,
      // but we also add an explicit ACL as defense-in-depth
      appendRule(aclRules, normalizedDir, `deny:agent:${agentName}`);  // deny all
      appendRule(aclRules, normalizedDir, `allow:scope:relayfile:fs:read:${normalizedDir}/*`);  // re-allow read
    }
  });

  // Build scopes: start with full read, then add write for non-restricted paths
  const scopes = [
    `relayfile:fs:read:*`,  // Can read everything not ACL-denied
    `relayfile:fs:write:*`, // Can write everything not ACL-denied
  ];
  // ACL markers handle the fine-grained deny; scopes are broad.
  // This is the correct approach because relayfile checks BOTH token scopes AND ACL markers.
  // The ACL deny rules override the broad scopes.

  return { aclRules, scopes, deniedPatterns };
}

function appendRule(map: Map<string, string[]>, dir: string, rule: string): void {
  const existing = map.get(dir) ?? [];
  if (!existing.includes(rule)) {
    existing.push(rule);
    map.set(dir, existing);
  }
}

function walkDir(
  baseDir: string,
  currentDir: string,
  callback: (relativePath: string, isDirectory: boolean) => void,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip dot-relay and hidden config dirs
    if (entry.name.startsWith(".relay") || entry.name === "node_modules") continue;

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    callback(relativePath, entry.isDirectory());

    if (entry.isDirectory()) {
      walkDir(baseDir, fullPath, callback);
    }
  }
}
```

### 2.3 How Dot Files Map to Relayfile ACL

The mapping works at two levels — **ACL markers** (path-level enforcement in relayfile) and **token scopes** (broad capability grants):

#### Ignored files → Full deny

```
.agentignore contains: secrets/

Result for agent "code-agent":
  ACL: /secrets/.relayfile.acl → ["deny:agent:code-agent"]
  Token: broad scopes remain, but ACL denies access to /secrets/
  Effect: code-agent cannot read or write anything under /secrets/
```

#### Readonly files → Deny + re-allow read

```
.agentreadonly contains: *.md

Result for agent "code-agent" and file /README.md:
  ACL: /.relayfile.acl → ["deny:agent:code-agent", "allow:scope:relayfile:fs:read:/*"]
  Token: has relayfile:fs:read:* and relayfile:fs:write:*
  Effect: ACL deny blocks all access, then allow re-grants read-only
          The write scope in the token is irrelevant because ACL deny takes precedence
```

#### Why ACL markers over scope restriction

Relayfile's ACL system is path-based with ancestor walking (`resolveFilePermissions`). Token scopes use the `service:resource:action:path` format. Dot-file patterns are globs (e.g., `**/*.pem`).

**Problem:** You can't express `**/*.pem` as a relayfile scope path — scopes use literal paths with `*` only as a full-segment wildcard.

**Solution:** Use ACL markers for glob-based restrictions. The compiler walks the actual file tree, evaluates which files match the glob patterns, and creates ACL deny rules on the appropriate directories. Token scopes stay broad (`relayfile:fs:read:*`, `relayfile:fs:write:*`); ACL markers do the fine-grained enforcement.

**Defense in depth:** Relayfile checks _both_ token scopes AND ACL markers. A request must pass both checks. The ACL deny rules are the primary enforcement mechanism for dot-file restrictions.

### 2.4 Zero-Config Mode

If no `relay.yaml` exists but dot files are present, `relay up` auto-provisions:

```bash
# In cmd_up, before parse_config_json:
ensure_config() {
  if [[ -f "relay.yaml" ]]; then
    return 0
  fi

  # Check for any dot files
  local has_dotfiles=false
  for f in .agentignore .agentreadonly .*.agentignore .*.agentreadonly; do
    if compgen -G "${f}" > /dev/null 2>&1; then
      has_dotfiles=true
      break
    fi
  done

  if [[ "${has_dotfiles}" == "false" ]]; then
    error "no relay.yaml or dot files found"
  fi

  echo "No relay.yaml found; using dot-file zero-config mode"

  # Extract agent names from per-agent dot files
  local agents=("default")
  for f in .*.agentignore .*.agentreadonly; do
    [[ -f "${f}" ]] || continue
    local name="${f#.}"
    name="${name%.agentignore}"
    name="${name%.agentreadonly}"
    [[ -n "${name}" && "${name}" != "*" ]] && agents+=("${name}")
  done
  # Deduplicate
  agents=($(printf '%s\n' "${agents[@]}" | sort -u))

  # Generate minimal relay.yaml
  cat > "relay.yaml" <<YAML
version: "1"
workspace: "local"
signing_secret: "dev-$(openssl rand -hex 16)"
agents:
YAML

  for agent in "${agents[@]}"; do
    cat >> "relay.yaml" <<YAML
  - name: "${agent}"
    scopes:
      - "relayfile:fs:read:*"
      - "relayfile:fs:write:*"
YAML
  done

  echo "Generated relay.yaml with agents: ${agents[*]}"
}
```

**Flow in zero-config mode:**
1. User drops `.agentignore` in project root
2. Runs `relay up`
3. No `relay.yaml` found → detect dot files → generate minimal relay.yaml
4. `relay provision` compiles dot files into ACL markers
5. Agent tokens get broad scopes; ACL markers enforce restrictions

### 2.5 Integration into `relay provision`

After identity creation and token issuance, provision also compiles dot files:

```bash
# At the end of cmd_provision, after existing ACL seeding:

# Compile dot-file permissions into additional ACL rules
if ls .agentignore .agentreadonly .*.agentignore .*.agentreadonly 2>/dev/null | head -1 > /dev/null; then
  echo "Compiling dot-file permissions..."
  npx tsx "${SCRIPT_DIR}/dotfile-compiler.ts" \
    --project-dir "$(pwd)" \
    --config "relay.yaml" \
    --base-url "${DEFAULT_RELAYFILE_URL}" \
    --token "${admin_token}"
fi
```

The compiler CLI reads dot files, walks the project tree, generates ACL rules, and PUTs them to relayfile as `.relayfile.acl` markers — same mechanism as `seed-acl.ts`.

### 2.6 Cascading & Precedence Rules

| Priority | Source | Wins over |
|----------|--------|-----------|
| 1 (highest) | `relay.yaml` ACL rules (Tier 2) | Everything |
| 2 | Per-agent dot file (`.{agent}.agentignore`) | Global dot file |
| 3 | Global dot file (`.agentignore`) | Default (open) |
| 4 (lowest) | Default: full read+write | — |

**Deny wins at same level:** If both `.agentignore` and `.agentreadonly` match a path, ignore (deny all) wins. This is enforced in the compiler:

```typescript
if (perms.ignored.ignores(relativePath)) {
  // Full deny — skip readonly check
} else if (perms.readonly.ignores(relativePath)) {
  // Read-only
}
```

**Child directory override:** Dot files in subdirectories work because the `ignore` package supports negation. A child `.agentignore` with `!specific-file.md` would un-ignore that file. The compiler also processes ACL rules per-directory, so child-directory ACLs naturally take precedence in relayfile's ancestor walk (closest ancestor wins).

### 2.7 Summary of New Files

| File | Purpose |
|------|---------|
| `scripts/relay/dotfile-parser.ts` | Parse .agentignore/.agentreadonly with `ignore` npm package |
| `scripts/relay/dotfile-compiler.ts` | Convert parsed permissions to relayfile ACL rules + scopes |

### 2.8 Example End-to-End Flow

```bash
# Project layout:
my-project/
├── .agentignore          # secrets/, .env, **/*.key
├── .agentreadonly         # README.md, LICENSE, package-lock.json
├── .code-agent.agentignore  # also hide docs/ from code-agent
├── src/
│   └── app.ts
├── secrets/
│   └── api.key
└── docs/
    └── guide.md

# User runs:
$ relay up        # builds, migrates, starts services
$ relay provision # creates agents, compiles dot files → ACL markers

# Result for "code-agent":
# Token scopes: [relayfile:fs:read:*, relayfile:fs:write:*]
# ACL markers:
#   /secrets/.relayfile.acl   → ["deny:agent:code-agent"]
#   /.relayfile.acl           → ["deny:agent:code-agent", "allow:scope:relayfile:fs:read:/*"]
#   /docs/.relayfile.acl      → ["deny:agent:code-agent"]
#
# code-agent can: read+write src/, read README.md
# code-agent cannot: see secrets/, write README.md, see docs/

# Result for "default" agent (no per-agent dot files):
# Same as above minus the docs/ restriction
```
