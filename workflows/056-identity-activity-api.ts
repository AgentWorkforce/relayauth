/**
 * 056-identity-activity-api.ts
 *
 * Domain 6: Audit & Observability
 * GET /v1/identities/:id/activity — identity-scoped audit view
 *
 * Depends on: 052, 022
 * Run: agent-relay run workflows/056-identity-activity-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('056-identity-activity-api')
  .description('GET /v1/identities/:id/activity — identity-scoped audit view')
  .pattern('dag')
  .channel('wf-relayauth-056')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design identity activity API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for identity activity API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement identity activity API route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review identity activity API for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit-spec.md`,
    captureOutput: true,
  })

  .step('read-audit-query', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/audit-query.ts`,
    captureOutput: true,
  })

  .step('read-identity-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-audit-spec', 'read-audit-query', 'read-identity-types', 'read-test-helpers'],
    task: `Write tests for the identity activity API.
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity


Audit spec:
{{steps.read-audit-spec.output}}

Audit query route:
{{steps.read-audit-query.output}}

Identity types:
{{steps.read-identity-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/identity-activity-api.test.ts.
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity

Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. GET /v1/identities/:id/activity returns audit entries for that identity
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity

2. Results are filtered to only the specified identity's entries
3. Supports action filter query param
4. Supports date range filters (from, to)
5. Supports cursor-based pagination
6. Returns 404 if identity does not exist
7. Returns 401 without valid auth token
8. Returns 403 without relayauth:audit:read scope
9. Only returns entries within the caller's org`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/identity-activity-api.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-query', 'read-identity-types'],
    task: `Implement the identity activity API route to make the tests pass.
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity


Audit spec:
{{steps.read-audit-spec.output}}

Audit query route (reuse query logic):
{{steps.read-audit-query.output}}

Identity types:
{{steps.read-identity-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/routes/identity-activity.ts:
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity

1. GET /v1/identities/:id/activity route handler
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity

2. Verify the identity exists (return 404 if not)
3. Reuse audit query logic, pre-filtered to identityId = :id
4. Enforce org scoping — caller can only see entries in their org
5. Support additional filters: action, from, to
6. Cursor-based pagination (default limit 50)
7. Require auth with relayauth:audit:read scope

Register the route in the server.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/identity-activity.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/identity-activity-api.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the identity activity API implementation.
    - Budget usage in response: actionsThisHour, costToday, percentOfBudget
    - sponsorChain in activity response
    - Sub-agent tree: list all agents spawned by this identity


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover identity-scoped filtering
2. Org scoping is enforced (no cross-org leaks)
3. Identity existence check is correct
4. Query logic is reused from audit-query
5. Auth and scope checks are enforced

List issues to fix (or confirm all good).`,
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/identity-activity-api.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n056 Identity Activity API: ${result.status}`);
}

main().catch(console.error);
