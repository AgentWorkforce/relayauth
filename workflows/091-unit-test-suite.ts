/**
 * 091-unit-test-suite.ts
 *
 * Domain 11: Testing & CI
 * Complete unit tests for all engine functions
 *
 * Depends on: 001-050
 * Run: agent-relay run workflows/091-unit-test-suite.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('091-unit-test-suite')
  .description('Complete unit tests for all engine functions')
  .pattern('dag')
  .channel('wf-relayauth-091')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan unit test coverage, fix failures across all packages',
    cwd: ROOT,
  })
  .agent('test-engine', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write unit tests for server engine functions',
    cwd: ROOT,
  })
  .agent('test-sdk', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write unit tests for SDK functions',
    cwd: ROOT,
  })
  .agent('test-types', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write unit tests for types package validators',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review test coverage, quality, and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read ───────────────────────────────────────────────

  .step('read-engine-files', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/server/src/engine -name "*.ts" -not -name "*.test.ts" | head -20 | xargs -I{} sh -c 'echo "=== {} ===" && head -50 {}'`,
    captureOutput: true,
  })

  .step('read-sdk-files', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/sdk/src -name "*.ts" -not -name "*.test.ts" -not -path "*/__tests__/*" | head -20 | xargs -I{} sh -c 'echo "=== {} ===" && head -50 {}'`,
    captureOutput: true,
  })

  .step('read-types-files', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/types/src -name "*.ts" -not -name "*.test.ts" -not -path "*/__tests__/*" | head -20 | xargs -I{} sh -c 'echo "=== {} ===" && head -50 {}'`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-existing-tests', {
    type: 'deterministic',
    command: `find ${ROOT}/packages -name "*.test.ts" | sort`,
    captureOutput: true,
  })

  // ── Phase 2: Plan + Write (parallel workers) ────────────────────

  .step('plan-coverage', {
    agent: 'architect',
    dependsOn: ['read-engine-files', 'read-sdk-files', 'read-types-files', 'read-existing-tests'],
    task: `Plan comprehensive unit test coverage for all packages.

Engine files:
{{steps.read-engine-files.output}}

SDK files:
{{steps.read-sdk-files.output}}

Types files:
{{steps.read-types-files.output}}

Existing tests:
{{steps.read-existing-tests.output}}

Write a test plan to ${ROOT}/docs/091-test-plan.md listing:
1. Every engine function that needs tests (JWT signing, token issuance, scope parsing, etc.)
2. Every SDK method that needs tests (verify, client methods, scope checker)
3. Every types validator/parser that needs tests
4. Which files already have tests (skip those)
Keep the plan under 50 lines.`,
    verification: { type: 'exit_code' },
  })

  .step('write-engine-tests', {
    agent: 'test-engine',
    dependsOn: ['plan-coverage', 'read-engine-files', 'read-test-helpers'],
    task: `Write unit tests for all server engine functions.

Plan:
{{steps.plan-coverage.output}}

Engine code:
{{steps.read-engine-files.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write tests to ${ROOT}/packages/server/src/__tests__/engine.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test: JWT signing, token issuance, scope parsing/matching, RBAC evaluation, audit logging.
Each function gets at least 2 test cases (happy path + error).`,
    verification: { type: 'exit_code' },
  })

  .step('write-sdk-tests', {
    agent: 'test-sdk',
    dependsOn: ['plan-coverage', 'read-sdk-files'],
    task: `Write unit tests for all SDK functions.

Plan:
{{steps.plan-coverage.output}}

SDK code:
{{steps.read-sdk-files.output}}

Write tests to ${ROOT}/packages/sdk/src/__tests__/sdk.test.ts.
Use node:test + node:assert/strict.
Test: TokenVerifier, RelayAuthClient methods, ScopeChecker, error classes.
Each method gets at least 2 test cases (happy path + error).`,
    verification: { type: 'exit_code' },
  })

  .step('write-types-tests', {
    agent: 'test-types',
    dependsOn: ['plan-coverage', 'read-types-files'],
    task: `Write unit tests for types package validators and parsers.

Plan:
{{steps.plan-coverage.output}}

Types code:
{{steps.read-types-files.output}}

Write tests to ${ROOT}/packages/types/src/__tests__/types.test.ts.
Use node:test + node:assert/strict.
Test: scope format validation, type guards, SCOPE_TEMPLATES, ParsedScope creation.
Each validator gets at least 2 test cases.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-engine-tests', 'write-sdk-tests', 'write-types-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/engine.test.ts && echo "engine.test.ts OK" || echo "engine.test.ts MISSING"; test -f ${ROOT}/packages/sdk/src/__tests__/sdk.test.ts && echo "sdk.test.ts OK" || echo "sdk.test.ts MISSING"; test -f ${ROOT}/packages/types/src/__tests__/types.test.ts && echo "types.test.ts OK" || echo "types.test.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/engine.test.ts packages/sdk/src/__tests__/sdk.test.ts packages/types/src/__tests__/types.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
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
    task: `Review the unit test suite.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read all three test files. Check:
1. Coverage of all engine functions
2. Coverage of all SDK methods
3. Coverage of all type validators
4. Edge cases and error paths tested
5. No test dependencies on external state
List issues to fix.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix all issues from the review.

Reviewer feedback:
{{steps.review.output}}

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Fix all failing tests and coverage gaps. Then run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/engine.test.ts packages/sdk/src/__tests__/sdk.test.ts packages/types/src/__tests__/types.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n091 Unit Test Suite: ${result.status}`);
}

main().catch(console.error);
