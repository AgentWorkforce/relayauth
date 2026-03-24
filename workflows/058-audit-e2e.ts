/**
 * 058-audit-e2e.ts
 *
 * Domain 6: Audit & Observability
 * E2E: perform actions → query audit → verify entries → test retention
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"

 *
 * Depends on: 051, 052, 053, 054, 055, 056, 057
 * Run: agent-relay run workflows/058-audit-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('058-audit-e2e')
  .description('Audit & Observability E2E tests')
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"

  .pattern('pipeline')
  .channel('wf-relayauth-058')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E test scenarios, fix failures',
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"

    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E test file',
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"

    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"

    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/audit-logger.ts && echo "=== QUERY ===" && cat ${ROOT}/packages/server/src/routes/audit-query.ts && echo "=== EXPORT ===" && cat ${ROOT}/packages/server/src/routes/audit-export.ts && echo "=== RETENTION ===" && cat ${ROOT}/packages/server/src/engine/audit-retention.ts && echo "=== WEBHOOKS ===" && cat ${ROOT}/packages/server/src/routes/audit-webhooks.ts && echo "=== DISPATCHER ===" && cat ${ROOT}/packages/server/src/engine/audit-webhook-dispatcher.ts && echo "=== ACTIVITY ===" && cat ${ROOT}/packages/server/src/routes/identity-activity.ts && echo "=== STATS ===" && cat ${ROOT}/packages/server/src/routes/dashboard-stats.ts`,
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
    task: `Write E2E tests for the Audit & Observability domain.
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"


Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/audit.test.ts.
Use node:test + node:assert/strict. Import helpers from ../test-helpers.js.

Test the full audit flow:
1. Perform auth actions (issue token, create identity, check scope) that generate audit entries
2. Query GET /v1/audit and verify entries exist for each action
3. Filter audit entries by identityId and verify only matching entries returned
4. Filter by action type and verify correct filtering
5. Filter by date range and verify correct filtering
6. Export audit entries as JSON via POST /v1/audit/export
7. Export audit entries as CSV via POST /v1/audit/export and verify CSV format
8. Create a webhook subscription via POST /v1/audit/webhooks
9. List webhook subscriptions via GET /v1/audit/webhooks
10. Delete webhook subscription via DELETE /v1/audit/webhooks/:id
11. Query identity activity via GET /v1/identities/:id/activity
12. Verify identity activity only returns entries for that identity
13. Query dashboard stats via GET /v1/stats
14. Verify stats reflect the actions performed
15. Test retention: insert old entries, run purge, verify deleted`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/audit.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/audit.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results.
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"


Results:
{{steps.run-e2e.output}}

Check:
1. All scenarios pass
2. Full audit lifecycle is covered (log → query → export → retention)
3. Webhook CRUD is tested
4. Identity activity scoping is verified
5. Dashboard stats reflect real actions
6. Proper cleanup between tests
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures.
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"


Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/audit.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n058 Audit E2E: ${result.status}`);
    Test scenarios:
    - Audit entry includes full sponsorChain
    - Budget breach generates "budget.exceeded" audit event
    - Budget alert webhook fires at configured threshold
    - Scope escalation attempt logged with "scope.escalation_denied"

}

main().catch(console.error);
