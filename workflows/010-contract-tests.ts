/**
 * 010-contract-tests.ts
 *
 * Domain 1: Foundation
 * Tests that verify implementation matches OpenAPI spec
 *
 * Depends on: 002
 * Run: agent-relay run workflows/010-contract-tests.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('010-contract-tests')
  .description('Tests that verify implementation matches OpenAPI spec')
  .pattern('pipeline')
  .channel('wf-relayauth-010')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design contract test scenarios, fix failures',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write contract test file',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review contract test coverage and results',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-openapi', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/openapi.yaml`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-openapi', 'read-test-helpers', 'read-worker'],
    task: `Write contract tests that verify the server matches the OpenAPI spec.

OpenAPI spec:
{{steps.read-openapi.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Server worker:
{{steps.read-worker.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/contract.test.ts.
Use node:test + node:assert/strict. Test:
- /health returns 200 with { status: "ok" }
- All defined endpoints return correct status codes
- Error responses match the spec error format
- Response content-type is application/json
- Required fields are present in responses
- Auth header is required on protected endpoints

Note: many endpoints won't be implemented yet. Test only /health
and the response format contract. Add skipped tests for future endpoints
with comments referencing the OpenAPI path.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/contract.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/contract.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review contract test results.

Results:
{{steps.run-e2e.output}}

Check:
1. Health endpoint test passes
2. Contract format tests are correct
3. Skipped tests reference correct OpenAPI paths
4. Tests will be progressively enabled as endpoints are built
5. No false positives or brittle assertions
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix contract test failures.

Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/contract.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n010 Contract Tests: ${result.status}`);
}

main().catch(console.error);
