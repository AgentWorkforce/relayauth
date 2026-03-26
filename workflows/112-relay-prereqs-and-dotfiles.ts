/**
 * 112-relay-prereqs-and-dotfiles.ts
 *
 * Two goals:
 *  1. Handle all prerequisites so "relay up" just works locally
 *     (build relayfile, seed D1, verify services, bootstrap admin token)
 *  2. Implement the .agentignore/.agentreadonly dot-file permission model
 *     so users get sandboxed agents with ZERO config
 *
 * The dot-file model (Tier 1) is the simple interface:
 *   .agentignore           → files invisible to all agents
 *   .{agentId}.agentignore → files invisible to specific agent
 *   .agentreadonly         → files read-only for all agents
 *   .{agentId}.agentreadonly → files read-only for specific agent
 *
 * These compile down to relayfile ACL rules and scopes at provision time.
 *
 * Run: agent-relay run workflows/112-relay-prereqs-and-dotfiles.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('112-relay-prereqs-and-dotfiles')
  .description('Handle relay prereqs and implement .agentignore/.agentreadonly dot-file permissions')
  .pattern('dag')
  .channel('wf-relay-prereqs-112')
  .maxConcurrency(5)
  .timeout(2_400_000)

  // ── Agents ──────────────────────────────────────────────────────────

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'Designs the dot-file permission model, coordinates all workers, reviews integration',
    cwd: RELAYAUTH,
  })
  .agent('prereq-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Handles build prereqs: relayfile binary, D1 migrations, service health checks',
    cwd: RELAYAUTH,
  })
  .agent('dotfile-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implements the dot-file parser (.agentignore, .agentreadonly) and compiler to ACL rules',
    cwd: RELAYAUTH,
  })
  .agent('relay-up-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Updates relay.sh to handle prereqs, dot-file compilation, and zero-config mode',
    cwd: RELAYAUTH,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Writes end-to-end test for the dot-file permission flow',
    cwd: RELAYAUTH,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Reviews the full flow: prereqs, dot-file parsing, ACL compilation, and relay up experience',
    cwd: RELAYAUTH,
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════════

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/specs/work-on-the-relay.md`,
    captureOutput: true,
  })

  .step('read-relayfile-acl', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/packages/core/src/acl.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-makefile', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/Makefile`,
    captureOutput: true,
  })

  .step('read-relay-sh', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/scripts/relay/relay.sh`,
    captureOutput: true,
  })

  .step('read-relayauth-migrations', {
    type: 'deterministic',
    command: `ls ${RELAYAUTH}/packages/server/src/db/migrations/ && cat ${RELAYAUTH}/wrangler.toml | head -30`,
    captureOutput: true,
  })

  .step('read-relayfile-auth', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/internal/httpapi/auth.go`,
    captureOutput: true,
  })

  .step('read-generate-dev-token', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/scripts/generate-dev-token.sh`,
    captureOutput: true,
  })

  .step('read-seed-acl', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/scripts/relay/seed-acl.ts`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Design — lead designs both the prereqs and dot-file model
  // ═══════════════════════════════════════════════════════════════════

  .step('design', {
    agent: 'lead',
    dependsOn: [
      'read-spec', 'read-relayfile-acl', 'read-relayfile-makefile',
      'read-relay-sh', 'read-relayauth-migrations', 'read-relayfile-auth',
      'read-generate-dev-token', 'read-seed-acl',
    ],
    task: `Design two things: prereq handling and the dot-file permission model.

SPEC (includes the new Tier 1 / Tier 2 permission model):
{{steps.read-spec.output}}

RELAYFILE ACL (what we compile dot files into):
{{steps.read-relayfile-acl.output}}

RELAYFILE MAKEFILE:
{{steps.read-relayfile-makefile.output}}

CURRENT RELAY.SH:
{{steps.read-relay-sh.output}}

RELAYAUTH MIGRATIONS & WRANGLER:
{{steps.read-relayauth-migrations.output}}

RELAYFILE AUTH.GO:
{{steps.read-relayfile-auth.output}}

DEV TOKEN SCRIPT:
{{steps.read-generate-dev-token.output}}

ACL SEEDER:
{{steps.read-seed-acl.output}}

=== PART 1: PREREQS ===

Design updates to relay.sh so "relay up" handles everything automatically:

1. CHECK & BUILD RELAYFILE:
   - Check if ${RELAYFILE}/bin/relayfile exists
   - If not: cd ${RELAYFILE} && make build
   - Also check relayfile-mount binary

2. SEED D1 DATABASE:
   - Run: cd ${RELAYAUTH} && wrangler d1 migrations apply relayauth --local
   - Only if .wrangler/state doesn't exist yet (first run)

3. BOOTSTRAP ADMIN TOKEN:
   - The chicken-and-egg problem: need a token to call relayauth APIs,
     but relayauth issues tokens via its API
   - Solution: generate-dev-token.sh creates a local HS256 JWT directly
     (no API call needed — it signs with the shared SIGNING_KEY)
   - relay.sh already does this, but document it clearly

4. VERIFY SERVICES:
   - Health check both ports with retries (up to 30s)
   - Clear error messages if either fails to start

5. RELAYFILE AUD CHECK:
   - relayfile auth.go checks aud claim. Verify it accepts "relayfile" in the
     aud array (or if it's checking for exact string match vs array contains)
   - If it checks strictly, note what change is needed

=== PART 2: DOT-FILE PERMISSION MODEL ===

Design the .agentignore/.agentreadonly system:

1. PARSER MODULE: ${RELAYAUTH}/scripts/relay/dotfile-parser.ts
   - parse(projectDir: string, agentName: string) → { ignored: string[], readonly: string[] }
   - Read .agentignore + .{agentName}.agentignore → merged ignore list
   - Read .agentreadonly + .{agentName}.agentreadonly → merged readonly list
   - Support .gitignore syntax: globs, ** patterns, negation with !, comments with #
   - Use the "ignore" npm package (same one .gitignore uses) for pattern matching

2. COMPILER MODULE: ${RELAYAUTH}/scripts/relay/dotfile-compiler.ts
   - compile(parsed, agentName) → ACL rules compatible with relayfile
   - For ignored files: create deny:agent:{agentName} rules
   - For readonly files: the agent's token should only have read scope for those paths
   - Output: { aclRules: Map<dir, string[]>, scopes: string[] }
   - The scopes are what go into the agent's JWT token
   - The aclRules become .relayfile.acl marker files

3. HOW DOT FILES MAP TO RELAYFILE ACL:
   .agentignore entry "secrets/" for agent-1:
   → .relayfile.acl in /secrets/ gets rule: "deny:agent:agent-1"
   → agent-1's token does NOT get relayfile:fs:read:/secrets/* scope

   .agentreadonly entry "*.md" for agent-1:
   → agent-1's token gets relayfile:fs:read:* but NOT relayfile:fs:write:/*.md
   → Since relayfile scopes are path-based not glob-based, we need to
     handle this via ACL markers rather than scopes for glob patterns

4. ZERO-CONFIG MODE:
   - If no relay.yaml exists but dot files exist → auto-provision
   - relay up detects dot files, creates a default workspace + single agent
   - The agent gets all read/write scopes MINUS what dot files restrict
   - User just drops .agentignore and runs "relay up" — done

5. CASCADING RULES:
   - Dot files in child dirs override parent dirs
   - relay.yaml ACL rules (Tier 2) override dot files (Tier 1)
   - Per-agent dot files override global dot files
   - Deny always wins over allow at the same level

Write design to ${RELAYAUTH}/docs/prereqs-and-dotfiles-design.md.

Post summary to #wf-relay-prereqs-112. End with DESIGN_COMPLETE.`,
    verification: { type: 'output_contains', value: 'DESIGN_COMPLETE' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: Parallel implementation — 4 codex workers
  // ═══════════════════════════════════════════════════════════════════

  // --- Track A: prereqs in relay.sh ---

  .step('impl-prereqs', {
    agent: 'prereq-worker',
    dependsOn: ['design'],
    task: `Update relay.sh to handle all prerequisites automatically.

DESIGN:
{{steps.design.output}}

CURRENT RELAY.SH:
{{steps.read-relay-sh.output}}

WRANGLER CONFIG:
{{steps.read-relayauth-migrations.output}}

Edit ${RELAYAUTH}/scripts/relay/relay.sh to add a prereqs phase in the "up" command:

1. Add a check_prereqs() function that runs before starting services:

   check_prereqs() {
     echo "Checking prerequisites..."

     # Check relayfile binaries
     if [ ! -f "${RELAYFILE}/bin/relayfile" ]; then
       echo "Building relayfile..."
       (cd "${RELAYFILE}" && make build) || { echo "ERROR: Failed to build relayfile"; exit 1; }
     fi

     # Check D1 database (only on first run)
     if [ ! -d "${RELAYAUTH}/.wrangler" ]; then
       echo "Initializing relayauth database..."
       (cd "${RELAYAUTH}" && npx wrangler d1 migrations apply relayauth --local) || {
         echo "ERROR: Failed to initialize D1"; exit 1;
       }
     fi

     # Verify Go is installed
     command -v go >/dev/null 2>&1 || { echo "ERROR: Go is required. Install from https://go.dev"; exit 1; }

     # Verify wrangler is available
     command -v npx >/dev/null 2>&1 || { echo "ERROR: Node.js/npm is required"; exit 1; }

     echo "Prerequisites OK"
   }

2. Call check_prereqs at the start of the "up" command

3. Improve the health check loop with clear timeout messages:
   - Retry every 2s for up to 30s
   - If relayauth fails: "relayauth failed to start. Check ${RELAYAUTH}/.relay/logs/relayauth.log"
   - If relayfile fails: "relayfile failed to start. Check ${RELAYAUTH}/.relay/logs/relayfile.log"

4. Start relayfile using the built binary instead of "go run":
   ${RELAYFILE}/bin/relayfile instead of go run ./cmd/relayfile
   (Falls back to go run if binary doesn't exist)

5. Add a "relay doctor" command that checks all prereqs without starting services:
   - Go installed? Version?
   - Node.js installed? Version?
   - wrangler available?
   - relayfile binary built?
   - D1 database initialized?
   - Ports 8787 and 8080 available?

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // --- Track B: dot-file parser ---

  .step('impl-dotfile-parser', {
    agent: 'dotfile-worker',
    dependsOn: ['design'],
    task: `Implement the dot-file parser and compiler.

DESIGN:
{{steps.design.output}}

RELAYFILE ACL:
{{steps.read-relayfile-acl.output}}

ACL SEEDER:
{{steps.read-seed-acl.output}}

Create TWO modules:

=== MODULE 1: ${RELAYAUTH}/scripts/relay/dotfile-parser.ts ===

This module reads .agentignore and .agentreadonly files and returns
structured permission data.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';  // npm package — add to devDependencies

interface DotfilePermissions {
  ignored: string[];    // glob patterns that are invisible
  readonly: string[];   // glob patterns that are read-only
}

/**
 * Parse dot files for a specific agent from a project directory.
 *
 * Reads (in order of precedence, later overrides earlier):
 *   .agentignore           → global ignore
 *   .{agentName}.agentignore → per-agent ignore
 *   .agentreadonly         → global readonly
 *   .{agentName}.agentreadonly → per-agent readonly
 *
 * Supports .gitignore syntax: globs, **, negation with !, comments with #
 */
export function parseDotfiles(projectDir: string, agentName: string): DotfilePermissions {
  // Read and merge the files
  // Parse .gitignore-style patterns
  // Return structured data
}

/**
 * Check if a given file path is ignored for an agent.
 * Uses the "ignore" npm package for .gitignore-compatible matching.
 */
export function isIgnored(path: string, perms: DotfilePermissions): boolean { ... }

/**
 * Check if a given file path is read-only for an agent.
 */
export function isReadonly(path: string, perms: DotfilePermissions): boolean { ... }

/**
 * Detect if any dot files exist in a directory (for zero-config mode).
 */
export function hasDotfiles(projectDir: string): boolean { ... }

/**
 * Discover agent names from dot file filenames.
 * .code-agent.agentignore → "code-agent"
 * .docs-agent.agentreadonly → "docs-agent"
 * .agentignore → no agent name (global)
 * Returns Set of unique agent names found.
 */
export function discoverAgents(projectDir: string): Set<string> { ... }

=== MODULE 2: ${RELAYAUTH}/scripts/relay/dotfile-compiler.ts ===

This module compiles parsed dot-file permissions into relayfile ACL rules
and JWT scopes.

interface CompiledPermissions {
  /** Map of directory path → ACL rules for .relayfile.acl markers */
  aclRules: Map<string, string[]>;
  /** Scopes to include in the agent's JWT token */
  scopes: string[];
  /** Summary for logging */
  summary: { ignored: number; readonly: number; readwrite: number };
}

/**
 * Compile dot-file permissions into relayfile-compatible ACL rules.
 *
 * Strategy:
 * - For each ignored pattern: create "deny:agent:{agentName}" rules
 *   in the appropriate directory's .relayfile.acl
 * - For readonly patterns: agent gets relayfile:fs:read scope but no write
 * - For everything else: agent gets full read/write
 *
 * Since .gitignore patterns can be globs (*.md, src/**) but relayfile ACLs
 * are directory-scoped, we need to:
 * 1. Convert glob patterns to directory-level rules where possible
 * 2. For file-level globs, put rules in the parent directory's ACL
 */
export function compileDotfiles(
  perms: DotfilePermissions,
  agentName: string,
  workspaceName: string,
): CompiledPermissions { ... }

Also add "ignore" to devDependencies in ${RELAYAUTH}/package.json.

IMPORTANT: When creating ACL rules, use the format that relayfile's
parsePermissionRule() understands:
- "deny:agent:agent-name" → denies access to specific agent
- "allow:scope:relayfile:fs:read:/path/*" → allows read with scope
- "deny:scope:relayfile:fs:write:/path/*" → denies write with scope

Write all files to disk.`,
    verification: { type: 'exit_code' },
  })

  // --- Track C: relay.sh zero-config mode ---

  .step('impl-zero-config', {
    agent: 'relay-up-worker',
    dependsOn: ['design'],
    task: `Add zero-config mode to relay.sh so dot files work without relay.yaml.

DESIGN:
{{steps.design.output}}

CURRENT RELAY.SH:
{{steps.read-relay-sh.output}}

DEV TOKEN SCRIPT:
{{steps.read-generate-dev-token.output}}

Update ${RELAYAUTH}/scripts/relay/relay.sh:

1. Modify the "up" command to support ZERO-CONFIG mode:

   When relay.yaml does NOT exist:
   a. Check if .agentignore or .agentreadonly exists in current directory
   b. If yes: auto-create a temporary config:
      - workspace: directory name
      - signing_secret: auto-generated (or "dev-relay-secret" for simplicity)
      - Single agent: "default-agent" with full read/write minus dot-file restrictions
   c. Discover agent names from dot filenames:
      .code-agent.agentignore → agent "code-agent"
      .docs-agent.agentreadonly → agent "docs-agent"
      If no per-agent files, create a single "default-agent"
   d. If no relay.yaml AND no dot files: start services with a fully open agent
   e. Print: "No relay.yaml found. Using dot-file permissions (zero-config mode)"
   f. Print: "Discovered agents: code-agent, docs-agent (from dot files)"

2. Add "relay provision" support for dot files:

   After creating identities and tokens, if dot files exist:
   a. Call dotfile-parser.ts to parse .agentignore/.agentreadonly
   b. Call dotfile-compiler.ts to get ACL rules
   c. Call seed-acl.ts with the compiled rules
   d. Print summary: "Applied permissions: X files ignored, Y files read-only"

3. Add a "relay scan" command that shows what permissions would be applied:
   relay scan [agent-name]
   - Parses dot files (and relay.yaml if present)
   - Lists: "IGNORED: secrets/, .env, *.key"
   - Lists: "READ-ONLY: README.md, LICENSE, package-lock.json"
   - Lists: "READ/WRITE: everything else"
   - Useful for debugging before running relay up

4. Update "relay shell" to show the agent's effective permissions on entry:
   Entering relay shell as "code-agent"
   Ignored: secrets/, .env, *.key (3 patterns)
   Read-only: README.md, LICENSE (2 patterns)
   Read/write: everything else
   $

5. Make the "relay init" command create EXAMPLE dot files:
   relay init --dotfiles
   Creates:
   - .agentignore with common defaults (.env, secrets/, *.pem, *.key, node_modules/)
   - .agentreadonly with common defaults (README.md, LICENSE, *.lock)

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // --- Track D: end-to-end test ---

  .step('impl-e2e-test', {
    agent: 'test-worker',
    dependsOn: ['design'],
    task: `Write an end-to-end test for the dot-file permission flow.

DESIGN:
{{steps.design.output}}

Create ${RELAYAUTH}/scripts/relay/e2e-dotfiles.sh:

This test validates the ZERO-CONFIG dot-file flow:

1. SETUP:
   - Create a temp project directory
   - Create some test files:
     - src/app.ts (should be read/write)
     - src/handler.ts (should be read/write)
     - secrets/api-key.txt (should be ignored)
     - README.md (should be read-only)
     - .env (should be ignored)
   - Create .agentignore:
     secrets/
     .env
   - Create .agentreadonly:
     README.md
   - NO relay.yaml (zero-config mode)

2. PARSE TEST:
   - Call dotfile-parser.ts with the temp dir and agent "test-agent"
   - Verify: ignored = ["secrets/", ".env"]
   - Verify: readonly = ["README.md"]

3. COMPILE TEST:
   - Call dotfile-compiler.ts with parsed output
   - Verify: ACL rules contain deny:agent:test-agent for /secrets/
   - Verify: scopes include relayfile:fs:read:* but restrict write

4. INTEGRATION TEST (if services are running):
   - Start relayauth + relayfile with shared secret
   - Run relay provision with dot files
   - Get token for test-agent
   - Test: read src/app.ts → 200
   - Test: write src/app.ts → 200
   - Test: read secrets/api-key.txt → 403
   - Test: write README.md → 403
   - Test: read README.md → 200

5. PER-AGENT TEST:
   - Create .admin-agent.agentignore (empty — admin can see everything)
   - Create .admin-agent.agentreadonly (empty — admin can write everything)
   - Verify admin-agent has full access despite global dot files

Make it self-contained with colored output. Skip integration tests if
services aren't running (just test parser + compiler).

Write to disk and make executable.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: Verify — lead reviews all tracks
  // ═══════════════════════════════════════════════════════════════════

  .step('verify-prereqs', {
    agent: 'lead',
    dependsOn: ['impl-prereqs'],
    task: `Verify the prereq handling in relay.sh.

WORKER OUTPUT:
{{steps.impl-prereqs.output}}

1. Read ${RELAYAUTH}/scripts/relay/relay.sh
2. Verify check_prereqs() handles: relayfile binary, D1 migrations, Go, Node
3. Verify health check has clear error messages with log paths
4. Verify "relay doctor" command works
5. Fix any issues directly

End with VERIFY_PREREQS_DONE.`,
    verification: { type: 'output_contains', value: 'VERIFY_PREREQS_DONE' },
  })

  .step('verify-dotfiles', {
    agent: 'lead',
    dependsOn: ['impl-dotfile-parser', 'impl-zero-config'],
    task: `Verify the dot-file parser, compiler, and zero-config integration.

PARSER OUTPUT:
{{steps.impl-dotfile-parser.output}}

ZERO-CONFIG OUTPUT:
{{steps.impl-zero-config.output}}

1. Read ${RELAYAUTH}/scripts/relay/dotfile-parser.ts
2. Read ${RELAYAUTH}/scripts/relay/dotfile-compiler.ts
3. Read the updated relay.sh for zero-config changes
4. Verify:
   a. Parser handles .gitignore syntax correctly (globs, **, negation, comments)
   b. Compiler produces valid relayfile ACL rules
   c. Zero-config mode works: no relay.yaml + dot files → auto-provision
   d. "relay scan" shows effective permissions
   e. "relay init --dotfiles" creates sensible defaults
5. Test: create sample .agentignore and run parser via:
   echo -e "secrets/\\n.env\\n*.pem" > /tmp/test-agentignore
   npx tsx ${RELAYAUTH}/scripts/relay/dotfile-parser.ts /tmp test-agent
6. Fix any issues directly

Post results to #wf-relay-prereqs-112.

End with VERIFY_DOTFILES_DONE.`,
    verification: { type: 'output_contains', value: 'VERIFY_DOTFILES_DONE' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: Deterministic checks + focused reviews
  // ═══════════════════════════════════════════════════════════════════

  .step('check-files-exist', {
    type: 'deterministic',
    dependsOn: ['verify-prereqs', 'verify-dotfiles', 'impl-e2e-test'],
    command: `echo "=== RELAY SCRIPTS ===" && \
ls -la ${RELAYAUTH}/scripts/relay/*.sh ${RELAYAUTH}/scripts/relay/*.ts 2>/dev/null && \
echo "" && echo "=== DOTFILE PARSER ===" && \
test -f ${RELAYAUTH}/scripts/relay/dotfile-parser.ts && echo "EXISTS" || echo "MISSING" && \
echo "" && echo "=== DOTFILE COMPILER ===" && \
test -f ${RELAYAUTH}/scripts/relay/dotfile-compiler.ts && echo "EXISTS" || echo "MISSING" && \
echo "" && echo "=== E2E TEST ===" && \
test -f ${RELAYAUTH}/scripts/relay/e2e-dotfiles.sh && test -x ${RELAYAUTH}/scripts/relay/e2e-dotfiles.sh && echo "EXISTS+EXEC" || echo "MISSING" && \
echo "" && echo "=== RELAY.SH PREREQS ===" && \
grep -c "check_prereqs\|relay doctor\|relay scan" ${RELAYAUTH}/scripts/relay/relay.sh 2>/dev/null && \
echo "" && echo "=== ACL RULE FORMAT ===" && \
grep -c "deny:agent\|allow:scope" ${RELAYAUTH}/scripts/relay/dotfile-compiler.ts 2>/dev/null && \
echo "" && echo "FILES_CHECK_DONE"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('check-parser-syntax', {
    type: 'deterministic',
    dependsOn: ['verify-dotfiles'],
    command: `cd ${RELAYAUTH} && npx tsx --eval "
const { parseDotfiles, discoverAgents, hasDotfiles } = require('./scripts/relay/dotfile-parser.ts');
console.log('Parser module loads OK');
console.log('Exports:', typeof parseDotfiles, typeof discoverAgents, typeof hasDotfiles);
" 2>&1 | tail -10 && echo "PARSER_CHECK: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-dotfile-logic', {
    agent: 'reviewer',
    dependsOn: ['check-files-exist', 'check-parser-syntax'],
    task: `Review ONLY the dot-file parser and compiler logic for correctness.

FILES CHECK:
{{steps.check-files-exist.output}}

PARSER CHECK:
{{steps.check-parser-syntax.output}}

Read ONLY these two files:
- ${RELAYAUTH}/scripts/relay/dotfile-parser.ts
- ${RELAYAUTH}/scripts/relay/dotfile-compiler.ts

Verify these 4 things (nothing else):
1. Parser reads .agentignore + .{name}.agentignore + .agentreadonly + .{name}.agentreadonly
2. discoverAgents() extracts agent names from filenames correctly
3. Compiler outputs "deny:agent:X" rules (format relayfile understands)
4. Ignore wins over readonly when both match

Write a short verdict (max 20 lines) to stdout. No file output needed.
End with REVIEW_APPROVED or REVIEW_NEEDS_FIXES.`,
    verification: { type: 'exit_code' },
  })

  .step('review-relay-sh', {
    agent: 'reviewer',
    dependsOn: ['check-files-exist'],
    task: `Review ONLY relay.sh for prereq handling and zero-config mode.

FILES CHECK:
{{steps.check-files-exist.output}}

Read ONLY: ${RELAYAUTH}/scripts/relay/relay.sh

Verify these 3 things (nothing else):
1. check_prereqs() checks for relayfile binary, D1 database, Go, Node
2. Zero-config mode: when no relay.yaml, discovers agents from dot filenames
3. "relay scan" command exists and shows ignored/readonly/readwrite summary

Write a short verdict (max 15 lines) to stdout. No file output needed.
End with REVIEW_APPROVED or REVIEW_NEEDS_FIXES.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 6: Fix pass
  // ═══════════════════════════════════════════════════════════════════

  .step('fix-issues', {
    agent: 'lead',
    dependsOn: ['review-dotfile-logic', 'review-relay-sh'],
    task: `Address review feedback.

DOTFILE REVIEW:
{{steps.review-dotfile-logic.output}}

RELAY.SH REVIEW:
{{steps.review-relay-sh.output}}

If REVIEW_APPROVED, verify all files exist and summarize:
  ls -la ${RELAYAUTH}/scripts/relay/

If REVIEW_NEEDS_FIXES, fix each issue and verify.

Write a final getting-started guide to ${RELAYAUTH}/docs/going-on-the-relay.md:

# Going On The Relay

## Quick Start (zero config)

1. Create .agentignore in your project:
   secrets/
   .env
   *.pem

2. Create .agentreadonly:
   README.md
   LICENSE
   *.lock

3. Start the relay:
   source path/to/relay.sh
   relay up
   relay shell default-agent

4. You're on the relay. Permission-checked file access is active.

## With relay.yaml (power users)

[...]

## Commands Reference

relay up          — start services (builds deps if needed)
relay down        — stop services
relay shell <agent> — enter scoped shell
relay scan [agent]  — preview effective permissions
relay doctor      — check prerequisites
relay init --dotfiles — create starter dot files

Post to #wf-relay-prereqs-112. End with COMPLETE.`,
    verification: { type: 'output_contains', value: 'COMPLETE' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYAUTH,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n112 Relay Prereqs & Dotfiles: ${result.status}`);
}

main().catch(console.error);
