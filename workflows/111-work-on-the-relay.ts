/**
 * 111-work-on-the-relay.ts
 *
 * Domain: Cross-Repo Integration
 * Combines relayauth + relayfile into a local sandbox where agents operate
 * under granular, scoped file permissions using relay primitives.
 *
 * Pattern: hub-spoke with parallel claude leads + codex implementers
 * Agents: 2 claude leads (auth-lead, file-lead) + 3 codex workers + 1 reviewer
 *
 * The two leads work their respective repos in parallel, converging at
 * integration steps. Codex workers fan out for implementation.
 *
 * Run: agent-relay run workflows/111-work-on-the-relay.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('111-work-on-the-relay')
  .description('Build "work on the relay" — local sandbox combining relayauth + relayfile with granular file permissions')
  .pattern('dag')
  .channel('wf-relay-sandbox-111')
  .maxConcurrency(5)
  .timeout(2_400_000) // 40 min — cross-repo work

  // ── Agents ──────────────────────────────────────────────────────────

  .agent('auth-lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'Relayauth expert. Owns JWT claim mapping, token issuance changes, and relay CLI provisioning logic. Coordinates auth-worker.',
    cwd: RELAYAUTH,
  })
  .agent('file-lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'Relayfile expert. Owns relay.yaml parsing, ACL seeding, mount integration, and verifies relayfile accepts relayauth-issued tokens. Coordinates file-worker.',
    cwd: RELAYFILE,
  })
  .agent('auth-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implements relayauth token changes and relay CLI shell script',
    cwd: RELAYAUTH,
  })
  .agent('file-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implements relay.yaml parser, ACL seeder, and relayfile-side helpers',
    cwd: RELAYFILE,
  })
  .agent('integration-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Builds the relay CLI entry point and end-to-end integration test script',
    cwd: RELAYAUTH,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Cross-repo reviewer. Verifies JWT compatibility, scope alignment, and end-to-end permission enforcement between relayauth and relayfile.',
    cwd: RELAYAUTH,
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: Read context (parallel deterministic reads)
  // ═══════════════════════════════════════════════════════════════════

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/specs/work-on-the-relay.md`,
    captureOutput: true,
  })

  .step('read-relayauth-token-issuance', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/scripts/generate-dev-token.sh`,
    captureOutput: true,
  })

  .step('read-relayauth-token-types', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-relayauth-auth-lib', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/lib/auth.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-auth', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/internal/httpapi/auth.go`,
    captureOutput: true,
  })

  .step('read-relayfile-acl', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/packages/core/src/acl.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-dev-token-script', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/scripts/generate-dev-token.sh`,
    captureOutput: true,
  })

  .step('read-relayauth-scope-format', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/specs/scope-format.md`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Parallel design — both leads plan simultaneously
  // ═══════════════════════════════════════════════════════════════════

  .step('design-auth-changes', {
    agent: 'auth-lead',
    dependsOn: [
      'read-spec', 'read-relayauth-token-issuance',
      'read-relayauth-token-types', 'read-relayauth-auth-lib',
      'read-relayfile-auth',
    ],
    task: `You are the auth-lead. Design the relayauth-side changes needed for
"work on the relay".

SPEC:
{{steps.read-spec.output}}

CURRENT TOKEN ISSUANCE CODE:
{{steps.read-relayauth-token-issuance.output}}

CURRENT TOKEN TYPES:
{{steps.read-relayauth-token-types.output}}

CURRENT AUTH LIB:
{{steps.read-relayauth-auth-lib.output}}

RELAYFILE AUTH (what it expects):
{{steps.read-relayfile-auth.output}}

Your job:
1. Design the JWT claim mapping fix — the dev token script (generate-dev-token.sh)
   builds the JWT payload on line 17. It must add "workspace_id" (same as "wks")
   and "agent_name" fields so relayfile accepts the tokens. Also ensure "relayfile"
   is included in the "aud" array.
2. Identify the EXACT files and lines to change:
   - scripts/generate-dev-token.sh (the payload JSON on line 17)
   - packages/types/src/token.ts (add optional workspace_id, agent_name fields)
   - Any server-side code that builds JWT payloads (check role-assignments.ts,
     middleware/scope.ts, lib/auth.ts for verification-only vs issuance code)
3. Plan the relay CLI provisioning flow — "relay provision" will call
   generate-dev-token.sh with appropriate env vars per agent.

Write your plan to ${RELAYAUTH}/docs/auth-changes-plan.md.

Post a summary to #wf-relay-sandbox-111 so file-lead can see what claim fields
will be available. Tag file-lead.

End with DESIGN_AUTH_COMPLETE.`,
    verification: { type: 'output_contains', value: 'DESIGN_AUTH_COMPLETE' },
  })

  .step('design-file-changes', {
    agent: 'file-lead',
    dependsOn: [
      'read-spec', 'read-relayfile-auth', 'read-relayfile-acl',
      'read-relayfile-dev-token-script', 'read-relayauth-scope-format',
    ],
    task: `You are the file-lead. Design the relayfile-side changes needed for
"work on the relay".

SPEC:
{{steps.read-spec.output}}

RELAYFILE AUTH CODE:
{{steps.read-relayfile-auth.output}}

RELAYFILE ACL CODE:
{{steps.read-relayfile-acl.output}}

DEV TOKEN SCRIPT:
{{steps.read-relayfile-dev-token-script.output}}

RELAYAUTH SCOPE FORMAT:
{{steps.read-relayauth-scope-format.output}}

Your job:
1. Design the relay.yaml parser — a TypeScript module that reads relay.yaml and
   outputs structured config (agents, scopes, ACL rules, workspace name, secret).
2. Design the ACL seeding flow — how "relay provision" writes .relayfile.acl
   marker files via the relayfile API based on relay.yaml acl: entries.
3. Verify relayfile's auth.go will accept tokens with relayauth's claim structure
   (after auth-lead adds workspace_id + agent_name). Note any gaps.
4. Design the mount integration — how "relay mount" uses relayfile-mount with
   the agent's scoped token.

Write your plan to ${RELAYFILE}/docs/relay-integration-plan.md.

Post a summary to #wf-relay-sandbox-111 so auth-lead can coordinate. Tag auth-lead.

End with DESIGN_FILE_COMPLETE.`,
    verification: { type: 'output_contains', value: 'DESIGN_FILE_COMPLETE' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: Parallel implementation — 3 codex workers fan out
  // ═══════════════════════════════════════════════════════════════════

  // --- Track A: auth-worker implements relayauth token changes ---

  .step('impl-jwt-claim-mapping', {
    agent: 'auth-worker',
    dependsOn: ['design-auth-changes'],
    task: `Implement the JWT claim mapping fix in relayauth.

AUTH-LEAD'S PLAN:
{{steps.design-auth-changes.output}}

Do these changes:

1. In ${RELAYAUTH}/scripts/generate-dev-token.sh — modify the payload JSON (line 17) to add:
   - "workspace_id": set to the same value as "wks"
   - "agent_name": set to new RELAYAUTH_AGENT_NAME env var (default: subject name)
   - Change audience_json default to include "relayfile": ["relayauth","relayfile"]

2. In ${RELAYAUTH}/packages/types/src/token.ts, add the new optional fields
   to RelayAuthTokenClaims:
   - workspace_id?: string
   - agent_name?: string

3. Update any existing tests that verify token payload structure to include the
   new fields.

Keep changes minimal. Do NOT refactor surrounding code.

Write all changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // --- Track B: file-worker implements relay.yaml parser + ACL seeder ---

  .step('impl-relay-yaml-parser', {
    agent: 'file-worker',
    dependsOn: ['design-file-changes'],
    task: `Implement the relay.yaml parser.

FILE-LEAD'S PLAN:
{{steps.design-file-changes.output}}

Create ${RELAYAUTH}/scripts/relay/parse-config.ts:

This module:
1. Reads a relay.yaml file from disk (accept path as argument, default ./relay.yaml)
2. Parses YAML (use the "yaml" npm package — add to devDependencies in root package.json)
3. Validates the structure:
   - version: must be "1"
   - workspace: non-empty string
   - signing_secret: non-empty string
   - agents: array of { name: string, scopes: string[] }
   - acl: optional map of path -> string[] (permission rules)
   - roles: optional map of name -> { scopes: string[] }
4. Validates each scope string matches the format: plane:resource:action[:path]
5. Exports a parseRelayConfig(filePath: string) function returning typed config
6. Exports TypeScript types: RelayConfig, RelayAgent, RelayAcl, RelayRole

Also create ${RELAYAUTH}/scripts/relay/seed-acl.ts:

This module:
1. Takes parsed RelayConfig + relayfile base URL + admin token
2. For each ACL entry in config, PUTs a .relayfile.acl file via relayfile API:
   PUT /v1/workspaces/{ws}/fs/file?path={dir}/.relayfile.acl
   Body: { content: JSON.stringify({ semantics: { permissions: rules } }), encoding: "utf-8" }
3. Exports seedAcl(config, baseUrl, token) function

Write all files to disk.`,
    verification: { type: 'exit_code' },
  })

  // --- Track C: integration-worker builds the relay CLI script ---

  .step('impl-relay-cli-script', {
    agent: 'integration-worker',
    dependsOn: ['design-auth-changes', 'design-file-changes'],
    task: `Build the relay CLI entry point as a bash script.

AUTH PLAN:
{{steps.design-auth-changes.output}}

FILE PLAN:
{{steps.design-file-changes.output}}

Create ${RELAYAUTH}/scripts/relay/relay.sh — a bash script with these commands:

relay init:
  - Check relay.yaml exists in current dir
  - Parse it (call parse-config.ts via npx tsx)
  - Print summary: workspace name, number of agents, scopes per agent

relay up:
  - Read signing_secret from relay.yaml
  - Start relayauth: cd ${RELAYAUTH} && SIGNING_KEY=\$SECRET wrangler dev --port 8787 &
  - Start relayfile: cd ${RELAYFILE} && RELAYFILE_JWT_SECRET=\$SECRET RELAYFILE_BACKEND_PROFILE=durable-local go run ./cmd/relayfile &
  - Store PIDs in .relay/pids
  - Wait for health checks (curl localhost:8787/health && curl localhost:8080/health)
  - Print "Both services running"

relay down:
  - Read PIDs from .relay/pids
  - kill them gracefully (SIGTERM, then SIGKILL after 5s)
  - Remove .relay/pids

relay provision:
  - Generate admin token using ${RELAYAUTH}/scripts/generate-dev-token.sh
  - For each agent in relay.yaml:
    a. curl POST localhost:8787/v1/identities to create identity
    b. curl POST localhost:8787/v1/tokens to issue token with agent's scopes
    c. Store token in .relay/tokens/<agent-name>.jwt
  - Run ACL seeding (call seed-acl.ts via npx tsx)
  - Print summary

relay shell <agent-name>:
  - Read token from .relay/tokens/<agent-name>.jwt
  - Export RELAYFILE_TOKEN, RELAYFILE_BASE_URL, RELAYFILE_WORKSPACE
  - Print "Entering relay shell as <agent-name> with scopes: ..."
  - exec \$SHELL (drop into subshell with env vars set)

relay token <agent-name>:
  - Read and print token from .relay/tokens/<agent-name>.jwt

relay mount <agent-name> <dir>:
  - Read token
  - Run: ${RELAYFILE}/bin/relayfile-mount --base-url http://127.0.0.1:8080 \\
      --workspace \$WORKSPACE --token \$TOKEN --local-dir \$DIR

relay status:
  - Check if PIDs are alive
  - List provisioned agents and their scope counts
  - Print health of both services

Make it executable (chmod +x). Use clear error messages. Add a usage/help function.
Also create a one-line installer: ${RELAYAUTH}/scripts/relay/install.sh that
symlinks relay.sh to /usr/local/bin/relay.

Write all files to disk.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: Parallel verification — both leads verify their tracks
  // ═══════════════════════════════════════════════════════════════════

  .step('verify-auth-changes', {
    agent: 'auth-lead',
    dependsOn: ['impl-jwt-claim-mapping'],
    task: `Verify the JWT claim mapping implementation.

WORKER OUTPUT:
{{steps.impl-jwt-claim-mapping.output}}

1. Read the changed files: ${RELAYAUTH}/scripts/generate-dev-token.sh
   and ${RELAYAUTH}/packages/types/src/token.ts
2. Verify workspace_id and agent_name are added to the JWT payload
3. Verify "relayfile" is in the aud array
4. Run: cd ${RELAYAUTH} && npx turbo build && npx turbo typecheck
5. Run any existing token tests
6. If anything is wrong, fix it directly

Post results to #wf-relay-sandbox-111. Tag file-lead so they know the claim
format is finalized.

End with VERIFY_AUTH_COMPLETE.`,
    verification: { type: 'output_contains', value: 'VERIFY_AUTH_COMPLETE' },
  })

  .step('verify-file-changes', {
    agent: 'file-lead',
    dependsOn: ['impl-relay-yaml-parser'],
    task: `Verify the relay.yaml parser and ACL seeder.

WORKER OUTPUT:
{{steps.impl-relay-yaml-parser.output}}

1. Read ${RELAYAUTH}/scripts/relay/parse-config.ts and seed-acl.ts
2. Verify the parser handles all relay.yaml fields from the spec
3. Verify scope validation matches relayauth's scope format
4. Verify ACL seeding creates proper .relayfile.acl marker files
5. Create a test relay.yaml at ${RELAYAUTH}/scripts/relay/test-relay.yaml:

version: "1"
workspace: sandbox-test
signing_secret: dev-relay-secret
agents:
  - name: reader-agent
    scopes:
      - relayfile:fs:read:*
  - name: writer-agent
    scopes:
      - relayfile:fs:read:*
      - relayfile:fs:write:/src/*
  - name: admin-agent
    scopes:
      - relayfile:fs:read:*
      - relayfile:fs:write:*
      - relayauth:identity:read:*
acl:
  /secrets/:
    - deny:agent:reader-agent
    - deny:agent:writer-agent
    - allow:scope:relayfile:fs:read:/secrets/*
  /src/:
    - allow:scope:relayfile:fs:write:/src/*

6. Test: npx tsx ${RELAYAUTH}/scripts/relay/parse-config.ts test-relay.yaml
7. Fix any issues directly

Post results to #wf-relay-sandbox-111.

End with VERIFY_FILE_COMPLETE.`,
    verification: { type: 'output_contains', value: 'VERIFY_FILE_COMPLETE' },
  })

  .step('verify-relay-cli', {
    type: 'deterministic',
    dependsOn: ['impl-relay-cli-script'],
    command: `test -f ${RELAYAUTH}/scripts/relay/relay.sh && test -x ${RELAYAUTH}/scripts/relay/relay.sh && bash ${RELAYAUTH}/scripts/relay/relay.sh help 2>&1 && echo "CLI_VERIFIED" || echo "CLI_MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: Integration test — integration-worker builds E2E script
  // ═══════════════════════════════════════════════════════════════════

  .step('impl-e2e-test', {
    agent: 'integration-worker',
    dependsOn: ['verify-auth-changes', 'verify-file-changes', 'verify-relay-cli'],
    task: `Build an end-to-end integration test script.

AUTH VERIFICATION:
{{steps.verify-auth-changes.output}}

FILE VERIFICATION:
{{steps.verify-file-changes.output}}

CLI VERIFICATION:
{{steps.verify-relay-cli.output}}

Create ${RELAYAUTH}/scripts/relay/e2e-test.sh:

This script validates the full "work on the relay" flow:

1. SETUP:
   - Set SHARED_SECRET=e2e-test-secret
   - Start relayauth on :8787 (wrangler dev, background)
   - Start relayfile on :8080 (go run, background, durable-local profile)
   - Wait for both health endpoints (retry up to 30s)
   - Trap EXIT to kill both processes

2. PROVISION:
   - Use generate-dev-token.sh to create an admin token with scope "*"
   - Create identity "test-reader" via POST /v1/identities
   - Issue token for test-reader with scopes: ["relayfile:fs:read:/src/*"]
   - Create identity "test-writer" via POST /v1/identities
   - Issue token for test-writer with scopes: ["relayfile:fs:read:*", "relayfile:fs:write:/src/*"]

3. SEED FILES:
   - Use admin token to PUT a test file at /src/hello.ts via relayfile API
   - Use admin token to PUT a test file at /secrets/key.pem via relayfile API
   - Use admin token to PUT .relayfile.acl at /secrets/ with:
     ["deny:agent:test-reader", "allow:scope:relayfile:fs:read:/secrets/*"]

4. TEST READER:
   - GET /src/hello.ts with reader token → expect 200 ✓
   - GET /secrets/key.pem with reader token → expect 403 ✓
   - PUT /src/hello.ts with reader token → expect 403 (no write scope) ✓

5. TEST WRITER:
   - GET /src/hello.ts with writer token → expect 200 ✓
   - PUT /src/hello.ts with writer token → expect 200 ✓
   - PUT /secrets/key.pem with writer token → expect 403 (no write scope for /secrets) ✓

6. REPORT:
   - Print pass/fail for each assertion
   - Exit 0 if all pass, 1 if any fail

Make it self-contained and runnable without relay.yaml (hardcoded test values).
Add clear colored output (green pass, red fail).

Write to disk and make executable.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 6: Cross-repo review
  // ═══════════════════════════════════════════════════════════════════

  .step('cross-repo-review', {
    agent: 'reviewer',
    dependsOn: ['impl-e2e-test', 'verify-auth-changes', 'verify-file-changes'],
    task: `Review the complete "work on the relay" implementation across both repos.

AUTH LEAD RESULTS:
{{steps.verify-auth-changes.output}}

FILE LEAD RESULTS:
{{steps.verify-file-changes.output}}

E2E TEST:
{{steps.impl-e2e-test.output}}

Read and review these files:

RELAYAUTH CHANGES:
- ${RELAYAUTH}/scripts/generate-dev-token.sh (JWT claim mapping)
- ${RELAYAUTH}/packages/types/src/token.ts (type additions)
- ${RELAYAUTH}/scripts/relay/relay.sh (CLI script)
- ${RELAYAUTH}/scripts/relay/parse-config.ts (YAML parser)
- ${RELAYAUTH}/scripts/relay/seed-acl.ts (ACL seeder)
- ${RELAYAUTH}/scripts/relay/e2e-test.sh (integration test)

Verify:
1. JWT COMPATIBILITY: relayauth tokens now include workspace_id + agent_name +
   aud containing "relayfile" — matching what relayfile's auth.go expects
2. SCOPE ALIGNMENT: scopes in relay.yaml use the relayauth scope format
   (plane:resource:action:path) and relayfile's ACL checks match
3. ACL ENFORCEMENT: .relayfile.acl marker files correctly reference scopes
   that relayauth issues
4. CLI COMPLETENESS: relay.sh has all commands from the spec (init, up, down,
   provision, shell, token, mount, status)
5. E2E COVERAGE: test script covers read-allowed, read-denied, write-allowed,
   write-denied scenarios
6. SECURITY: shared secret handling is reasonable for local dev, no secrets
   committed to git

Write your review to ${RELAYAUTH}/docs/relay-integration-review.md.

If there are blocking issues, list them clearly with fix instructions.
If all looks good, end with REVIEW_APPROVED.
If issues found, end with REVIEW_NEEDS_FIXES.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 7: Fix pass — leads address review feedback in parallel
  // ═══════════════════════════════════════════════════════════════════

  .step('fix-auth-issues', {
    agent: 'auth-lead',
    dependsOn: ['cross-repo-review'],
    task: `Address any review feedback for relayauth-side changes.

REVIEW:
{{steps.cross-repo-review.output}}

If the review says REVIEW_APPROVED, just verify the build passes:
  cd ${RELAYAUTH} && npx turbo build && npx turbo typecheck

If the review says REVIEW_NEEDS_FIXES, fix each issue listed for relayauth.
Then rebuild and verify.

Post final status to #wf-relay-sandbox-111.

End with AUTH_FIXES_COMPLETE.`,
    verification: { type: 'output_contains', value: 'AUTH_FIXES_COMPLETE' },
  })

  .step('fix-file-issues', {
    agent: 'file-lead',
    dependsOn: ['cross-repo-review'],
    task: `Address any review feedback for relayfile-side changes.

REVIEW:
{{steps.cross-repo-review.output}}

If the review says REVIEW_APPROVED, just verify:
  cd ${RELAYFILE} && go build ./... && go test ./...

If the review says REVIEW_NEEDS_FIXES, fix each issue listed for relayfile.
Then rebuild and verify.

Post final status to #wf-relay-sandbox-111.

End with FILE_FIXES_COMPLETE.`,
    verification: { type: 'output_contains', value: 'FILE_FIXES_COMPLETE' },
  })

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 8: Final verification
  // ═══════════════════════════════════════════════════════════════════

  .step('final-file-check', {
    type: 'deterministic',
    dependsOn: ['fix-auth-issues', 'fix-file-issues'],
    command: `echo "=== RELAYAUTH FILES ===" && \
ls -la ${RELAYAUTH}/scripts/relay/ 2>/dev/null && \
echo "" && echo "=== TOKEN TYPES ===" && \
grep -n "workspace_id\|agent_name" ${RELAYAUTH}/packages/types/src/token.ts 2>/dev/null && \
echo "" && echo "=== TOKEN ISSUANCE ===" && \
grep -n "workspace_id\|agent_name" ${RELAYAUTH}/scripts/generate-dev-token.sh 2>/dev/null && \
echo "" && echo "=== RELAY.YAML TEST ===" && \
test -f ${RELAYAUTH}/scripts/relay/test-relay.yaml && echo "test config exists" && \
echo "" && echo "=== E2E TEST ===" && \
test -f ${RELAYAUTH}/scripts/relay/e2e-test.sh && test -x ${RELAYAUTH}/scripts/relay/e2e-test.sh && echo "e2e script exists and is executable" && \
echo "" && echo "ALL_FILES_PRESENT"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('summary', {
    agent: 'auth-lead',
    dependsOn: ['final-file-check'],
    task: `Write the final summary of "work on the relay" implementation.

FILE CHECK:
{{steps.final-file-check.output}}

Write ${RELAYAUTH}/docs/work-on-the-relay-summary.md containing:

1. WHAT WAS BUILT — list every file created/changed across both repos
2. HOW TO USE IT — step-by-step instructions:
   a. Place relay.yaml in project root
   b. source scripts/relay/relay.sh (or install via install.sh)
   c. relay up
   d. relay provision
   e. relay shell agent-1
   f. Use relayfile CLI or curl — permissions enforced
   g. relay down
3. ARCHITECTURE — how JWT flows from relayauth → relayfile
4. NEXT STEPS — what's left for post-MVP (from the spec)

Keep it concise and actionable.

Post the summary to #wf-relay-sandbox-111 for the team.

End with WORKFLOW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'WORKFLOW_COMPLETE' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYAUTH,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n111 Work On The Relay: ${result.status}`);
}

main().catch(console.error);
