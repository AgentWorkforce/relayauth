/**
 * 057-dashboard-stats-api.ts
 *
 * Domain 6: Audit & Observability
 * GET /v1/stats — aggregate stats (tokens issued, scopes checked, etc.)
 *
 * Depends on: 051
 * Run: agent-relay run workflows/057-dashboard-stats-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('057-dashboard-stats-api')
  .description('GET /v1/stats — aggregate stats (tokens issued, scopes checked, etc.)')
  .pattern('dag')
  .channel('wf-relayauth-057')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design dashboard stats API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for dashboard stats API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement dashboard stats API route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review dashboard stats API for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit-spec.md`,
    captureOutput: true,
  })

  .step('read-audit-logger', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/audit-logger.ts`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-audit-spec', 'read-audit-logger', 'read-audit-types', 'read-test-helpers'],
    task: `Write tests for the dashboard stats API.

Audit spec:
{{steps.read-audit-spec.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Audit types:
{{steps.read-audit-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/dashboard-stats-api.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. GET /v1/stats returns aggregate stats object
2. Stats include tokensIssued count
3. Stats include tokensRevoked count
4. Stats include scopeChecks count (allowed + denied)
5. Stats include scopeDenials count
6. Stats include activeIdentities count
7. Stats include suspendedIdentities count
8. Stats support time range filter (from, to query params)
9. Stats are scoped to the caller's org
10. Returns 401 without valid auth token
11. Returns 403 without relayauth:stats:read scope`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/dashboard-stats-api.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-logger', 'read-audit-types'],
    task: `Implement the dashboard stats API route to make the tests pass.

Audit spec:
{{steps.read-audit-spec.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Audit types:
{{steps.read-audit-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/routes/dashboard-stats.ts:
1. GET /v1/stats route handler
2. Query D1 audit_log table with COUNT + GROUP BY action
3. Query identities table for active/suspended counts
4. Support from/to date range filters
5. Scope all queries to caller's orgId
6. Require auth with relayauth:stats:read scope
7. Return JSON:
   {
     tokensIssued: number,
     tokensRevoked: number,
     tokensRefreshed: number,
     scopeChecks: number,
     scopeDenials: number,
     activeIdentities: number,
     suspendedIdentities: number,
     period: { from: string, to: string }
   }

Register the route in the server.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/dashboard-stats.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/dashboard-stats-api.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the dashboard stats API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover all stat categories
2. SQL aggregation queries are correct and parameterized
3. Org scoping is enforced
4. Time range filtering works
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/dashboard-stats-api.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n057 Dashboard Stats API: ${result.status}`);
}

main().catch(console.error);
