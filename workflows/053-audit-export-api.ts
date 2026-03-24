/**
 * 053-audit-export-api.ts
 *
 * Domain 6: Audit & Observability
 * POST /v1/audit/export — export logs as CSV/JSON
 *
 * Depends on: 052
 * Run: agent-relay run workflows/053-audit-export-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('053-audit-export-api')
  .description('POST /v1/audit/export — export logs as CSV/JSON')
  .pattern('dag')
  .channel('wf-relayauth-053')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit export API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for audit export API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement audit export API route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review audit export API for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit-spec.md`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-audit-query', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/audit-query.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-audit-spec', 'read-audit-types', 'read-audit-query', 'read-test-helpers'],
    task: `Write tests for the audit export API.

Audit spec:
{{steps.read-audit-spec.output}}

Audit types:
{{steps.read-audit-types.output}}

Audit query route:
{{steps.read-audit-query.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/audit-export-api.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. POST /v1/audit/export with format=json returns JSON array
2. POST /v1/audit/export with format=csv returns CSV with headers
3. CSV export includes all AuditEntry fields as columns
4. Export respects the same filters as query API (identityId, action, from, to, etc.)
5. Export has a max row limit (10000)
6. Returns 401 without valid auth token
7. Returns 403 without relayauth:audit:read scope
8. Returns 400 for invalid format parameter`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/audit-export-api.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-query'],
    task: `Implement the audit export API route to make the tests pass.

Audit spec:
{{steps.read-audit-spec.output}}

Audit query route (reuse query logic):
{{steps.read-audit-query.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/routes/audit-export.ts:
1. POST /v1/audit/export route handler
2. Accept body: { format: "json" | "csv", ...AuditQuery filters }
3. Reuse query building logic from audit-query route
4. For JSON: return Content-Type application/json with array
5. For CSV: return Content-Type text/csv with header row + data rows
6. Max 10000 rows per export
7. Require auth token with relayauth:audit:read scope
8. Return 400 for invalid format

Register the route in the server.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/audit-export.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-export-api.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the audit export API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover JSON and CSV export formats
2. CSV formatting is correct (proper escaping of commas, quotes)
3. Query logic is reused, not duplicated from audit-query
4. Row limit is enforced
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-export-api.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n053 Audit Export API: ${result.status}`);
}

main().catch(console.error);
