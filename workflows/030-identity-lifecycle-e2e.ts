/**
 * 030-identity-lifecycle-e2e.ts
 *
 * Domain 3: Identity Lifecycle
 * E2E: create -> update -> suspend -> reactivate -> retire
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error

 *
 * Depends on: 021, 022, 023, 024, 025, 026, 027, 028, 029
 * Run: agent-relay run workflows/030-identity-lifecycle-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('030-identity-lifecycle-e2e')
  .description('Identity Lifecycle E2E tests')
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error

  .pattern('pipeline')
  .channel('wf-relayauth-030')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E test scenarios, fix failures',
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error

    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E test file',
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error

    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error

    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/identities.ts && echo "=== DO ===" && cat ${ROOT}/packages/server/src/durable-objects/identity-do.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers'],
    task: `Write E2E tests for the Identity Lifecycle domain.
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error


Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/identity-lifecycle.test.ts.
Use node:test + node:assert/strict. Import helpers from ../test-helpers.js.

Test the full lifecycle flow in a single describe block:
1. POST /v1/identities — create an agent identity, verify 201
2. GET /v1/identities/:id — read back the created identity
3. GET /v1/identities — list identities, verify created one appears
4. PATCH /v1/identities/:id — update name and metadata
5. GET /v1/identities/:id — verify updates persisted
6. POST /v1/identities/:id/suspend — suspend with reason
7. GET /v1/identities/:id — verify status is "suspended"
8. POST /v1/identities/:id/reactivate — lift suspension
9. GET /v1/identities/:id — verify status is "active" again
10. POST /v1/identities/:id/retire — permanently retire
11. GET /v1/identities/:id — verify status is "retired"
12. POST /v1/identities/:id/reactivate — attempt reactivate retired, expect 409
13. DELETE /v1/identities/:id — delete with confirmation header
14. GET /v1/identities/:id — verify 404 after delete`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/identity-lifecycle.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/identity-lifecycle.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results.
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error


Results:
{{steps.run-e2e.output}}

Check:
1. All 14 lifecycle steps pass
2. State transitions are verified (active->suspended->active->retired)
3. Error cases covered (reactivate retired = 409)
4. Delete with confirmation works
5. Proper cleanup between tests
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures.
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error


Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/identity-lifecycle.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n030 Identity Lifecycle E2E: ${result.status}`);
    Test scenarios for new concepts:
    - Create identity with sponsor → verify sponsor in response
    - Create sub-agent → verify sponsorChain includes parent
    - Set budget { maxActionsPerHour: 5 } → perform 6 actions → verify auto-suspend
    - Suspend parent → verify sub-agents also suspended
    - Attempt create identity without sponsor → verify 400 error

}

main().catch(console.error);
