/**
 * 077-relayfile-integration.ts
 *
 * Domain 9: Integration
 * relayfile verifies relayauth tokens for fs operations
 *
 * Depends on: 063, 066
 * Run: agent-relay run workflows/077-relayfile-integration.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('077-relayfile-integration')
  .description('Replace relayfile auth with relayauth token verification')
  .pattern('dag')
  .channel('wf-relayauth-077')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan relayfile integration, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests for relayfile token verification',
    cwd: ROOT,
  })
  .agent('impl-relayfile', {
    cli: 'codex',
    preset: 'worker',
    role: 'Modify relayfile auth to use relayauth Go middleware',
    cwd: RELAYFILE,
  })
  .agent('impl-sdk', {
    cli: 'codex',
    preset: 'worker',
    role: 'Add relayfile integration helpers to relayauth SDK',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review relayfile integration for correctness and scope enforcement',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-relayfile-auth', {
    type: 'deterministic',
    command: `find ${RELAYFILE} -name "auth*.go" -o -name "middleware*.go" | head -5 | xargs cat 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relayfile-main', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/cmd/relayfile-mount/main.go 2>/dev/null || cat ${RELAYFILE}/main.go 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-go-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/go-middleware/middleware.go 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-sdk-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-relayfile-auth', 'read-relayfile-main', 'read-go-middleware', 'read-sdk-verify'],
    task: `Plan the relayfile integration with relayauth.

Relayfile current auth:
{{steps.read-relayfile-auth.output}}

Relayfile main:
{{steps.read-relayfile-main.output}}

Go middleware:
{{steps.read-go-middleware.output}}

Write a plan to ${ROOT}/docs/077-plan.md covering:
1. How relayfile Go code will import the relayauth Go middleware
2. Map fs operations to scopes (relayfile:fs:read, relayfile:fs:write)
3. Path-scoped access (relayfile:fs:read:/src/*)
4. Backwards compatibility with existing auth
5. Files to create/modify in both repos`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-test-helpers'],
    task: `Write integration tests for relayfile + relayauth.

Plan:
{{steps.plan.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/relayfile.test.ts.
Use node:test + node:assert/strict. Test:
1. relayauth token with relayfile:fs:read scope can read files
2. Token with relayfile:fs:write scope can write files
3. Token without relayfile scopes is rejected
4. Path-scoped token only accesses allowed paths
5. Expired token is rejected by relayfile`,
    verification: { type: 'exit_code' },
  })

  .step('implement-relayfile-auth', {
    agent: 'impl-relayfile',
    dependsOn: ['plan', 'read-relayfile-auth', 'read-go-middleware'],
    task: `Update relayfile to verify relayauth tokens.

Plan:
{{steps.plan.output}}

Current auth:
{{steps.read-relayfile-auth.output}}

Go middleware:
{{steps.read-go-middleware.output}}

Modify relayfile auth to:
1. Import relayauth Go middleware for JWKS-based verification
2. Extract scopes from verified token
3. Check relayfile:fs:read/write scopes per operation
4. Enforce path-scoped access (match request path against scope path)
5. Keep fallback for legacy auth during migration`,
    verification: { type: 'exit_code' },
  })

  .step('implement-sdk-adapter', {
    agent: 'impl-sdk',
    dependsOn: ['plan', 'read-sdk-verify'],
    task: `Add relayfile integration helpers to the SDK.

Plan:
{{steps.plan.output}}

SDK verifier:
{{steps.read-sdk-verify.output}}

Create ${ROOT}/packages/sdk/typescript/src/integrations/relayfile.ts:
1. createRelayfileVerifier(opts) — pre-configured TokenVerifier
2. RELAYFILE_SCOPES — constants for relayfile scope patterns
3. relayfileScopeCheck(token, action, path) — check fs scopes with path matching
Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-relayfile-auth', 'implement-sdk-adapter'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/relayfile.test.ts && echo "test OK" || echo "test MISSING"; test -f ${ROOT}/packages/sdk/typescript/src/integrations/relayfile.ts && echo "sdk-adapter OK" || echo "sdk-adapter MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/relayfile.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('typecheck', {
    type: 'deterministic',
    dependsOn: ['run-tests'],
    command: `cd ${ROOT} && npx turbo typecheck 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['run-tests', 'typecheck'],
    task: `Review the relayfile integration.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation files and check:
1. JWKS-based verification, not shared secrets
2. Path-scoped access is correctly enforced
3. Read vs write scope separation
4. Go middleware correctly validates JWT signatures
5. No path traversal vulnerabilities in scope matching
List issues to fix.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix issues from the review.

Reviewer feedback:
{{steps.review.output}}

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Fix all issues. Then run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/relayfile.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n077 Relayfile Integration: ${result.status}`);
}

main().catch(console.error);
