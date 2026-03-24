/**
 * 008-test-helpers-complete.ts
 *
 * Domain 1: Foundation
 * Full test helper suite: mocks, factories, assertions
 *
 * Depends on: 001
 * Run: agent-relay run workflows/008-test-helpers-complete.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('008-test-helpers-complete')
  .description('Full test helper suite: mocks, factories, assertions')
  .pattern('dag')
  .channel('wf-relayauth-008')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan test helper suite, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write test helper tests',
    cwd: ROOT,
  })
  .agent('impl-mocks', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement mock factories (D1, KV, DO)',
    cwd: ROOT,
  })
  .agent('impl-helpers', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement test utilities and assertion helpers',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review test helpers for completeness and usability',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-existing-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-helpers', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts && echo "=== IDENTITY ===" && cat ${ROOT}/packages/types/src/identity.ts && echo "=== AUDIT ===" && cat ${ROOT}/packages/types/src/audit.ts && echo "=== RBAC ===" && cat ${ROOT}/packages/types/src/rbac.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-existing-helpers', 'read-relaycast-helpers', 'read-types', 'read-env'],
    task: `Plan the full test helper suite.

Existing helpers:
{{steps.read-existing-helpers.output}}

Relaycast helpers (reference):
{{steps.read-relaycast-helpers.output}}

Types:
{{steps.read-types.output}}

Env bindings:
{{steps.read-env.output}}

Write plan to ${ROOT}/docs/008-plan.md. Two files to create:
1. test-helpers.ts — complete rewrite with: createTestApp, mockD1, mockKV, mockDO, generateTestToken, generateTestIdentity, generateTestRole, generateTestPolicy, generateTestAuditEntry, assertJsonResponse, createTestRequest
2. test-helpers.test.ts — tests for all helpers`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan'],
    task: `Write tests for the test helper suite.

Plan:
{{steps.plan.output}}

Types:
{{steps.read-types.output}}

Write to ${ROOT}/packages/server/src/__tests__/test-helpers.test.ts.
Use node:test + node:assert/strict. Test:
- createTestApp returns a working Hono app
- generateTestToken creates valid JWT structure
- generateTestIdentity returns valid AgentIdentity
- generateTestRole returns valid Role
- mockD1/mockKV/mockDO return mock objects with expected methods
- assertJsonResponse checks status and body`,
    verification: { type: 'exit_code' },
  })

  .step('implement-mocks', {
    agent: 'impl-mocks',
    dependsOn: ['plan', 'read-env'],
    task: `Implement mock factories in the test helpers file.

Plan:
{{steps.plan.output}}

Env bindings:
{{steps.read-env.output}}

Write mock factories to ${ROOT}/packages/server/src/__tests__/test-helpers.ts:
- mockD1(): returns object with prepare/batch/exec/dump methods
- mockKV(): returns object with get/put/delete/list methods
- mockDO(): returns Durable Object stub mock with fetch method
- createTestApp(): creates Hono app with all mocked bindings

Export all functions. Use @relayauth/types imports.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-helpers', {
    agent: 'impl-helpers',
    dependsOn: ['plan', 'read-types'],
    task: `Implement test utility functions.

Plan:
{{steps.plan.output}}

Types:
{{steps.read-types.output}}

Add to ${ROOT}/packages/server/src/__tests__/test-helpers.ts:
- generateTestToken(overrides?): creates JWT claims with defaults
- generateTestIdentity(overrides?): creates AgentIdentity
- generateTestRole(overrides?): creates Role
- generateTestPolicy(overrides?): creates Policy
- generateTestAuditEntry(overrides?): creates AuditEntry
- assertJsonResponse(res, status, check): assertion helper
- createTestRequest(method, path, body?, headers?): Request builder

All factories use sensible defaults with override support.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-mocks', 'implement-helpers'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/test-helpers.ts && echo "helpers OK" || echo "helpers MISSING"; test -f ${ROOT}/packages/server/src/__tests__/test-helpers.test.ts && echo "test OK" || echo "test MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/test-helpers.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the test helper suite.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. All helpers from the plan are implemented
2. Mock factories match the real binding interfaces
3. Fixture factories produce valid typed objects
4. Tests cover all exported helpers
5. Consistent with relaycast test helper patterns
List issues.`,
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/test-helpers.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n008 Test Helpers Complete: ${result.status}`);
}

main().catch(console.error);
