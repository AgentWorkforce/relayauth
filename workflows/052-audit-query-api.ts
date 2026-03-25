/**
 * 052-audit-query-api.ts
 *
 * Domain 6: Audit & Observability
 * GET /v1/audit — query audit logs with filters
 *
 * Depends on: 051
 * Run: agent-relay run workflows/052-audit-query-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('052-audit-query-api')
  .description('GET /v1/audit — query audit logs with filters')
  .pattern('dag')
  .channel('wf-relayauth-052')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit query API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for audit query API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement audit query API route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review audit query API for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit.md`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-audit-logger', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/audit-logger.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-audit-spec', 'read-audit-types', 'read-audit-logger', 'read-test-helpers'],
    task: `Write tests for the audit query API.

Audit spec:
{{steps.read-audit-spec.output}}

Audit types:
{{steps.read-audit-types.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/audit-query-api.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. GET /v1/audit returns paginated audit entries
2. Filter by identityId query param
3. Filter by action query param
4. Filter by orgId query param
5. Filter by date range (from, to)
6. Filter by result (allowed, denied)
7. Cursor-based pagination with limit
8. Returns 401 without valid auth token
9. Returns 403 without relayauth:audit:read scope`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/audit-query-api.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-logger'],
    task: `Implement the audit query API route to make the tests pass.

Audit spec:
{{steps.read-audit-spec.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/routes/audit-query.ts:
1. GET /v1/audit route handler
2. Parse query params: identityId, action, orgId, workspaceId, plane, result, from, to, cursor, limit
3. Build D1 query with WHERE clauses for each filter
4. Cursor-based pagination (use id as cursor)
5. Default limit 50, max 200
6. Require auth token with relayauth:audit:read scope
7. Return { entries: AuditEntry[], cursor?: string, hasMore: boolean }

Register the route in the server.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/audit-query.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-query-api.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the audit query API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover all spec requirements
2. SQL query building is safe (parameterized, no injection)
3. Pagination works correctly with cursor
4. Auth and scope checks are enforced
5. Consistent with existing route patterns

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-query-api.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n052 Audit Query API: ${result.status}`);
}

main().catch(console.error);
