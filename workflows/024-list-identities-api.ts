/**
 * 024-list-identities-api.ts
 *
 * Domain 3: Identity Lifecycle
 * GET /v1/identities — list/search identities
 *
 * Depends on: 022
 * Run: agent-relay run workflows/024-list-identities-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('024-list-identities-api')
  .description('GET /v1/identities — list/search identities')
  .pattern('dag')
  .channel('wf-relayauth-024')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design list identities API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for list identities endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement list identities route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review list identities API for quality and spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/identities.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-types', 'read-routes', 'read-test-helpers'],
    task: `Write tests for GET /v1/identities endpoint.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/list-identities.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- GET /v1/identities returns 200 with { data: [...], cursor?: string }
- Returns empty array when no identities exist
- Returns all identities for the org
- Supports ?status=active filter
- Supports ?type=agent filter
- Supports ?limit=N for pagination (default 50, max 100)
- Supports ?cursor=X for cursor-based pagination
- Results are sorted by createdAt descending`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/list-identities.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-routes'],
    task: `Implement GET /v1/identities route.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Tests to pass:
{{steps.write-tests.output}}

Add the GET / handler to ${ROOT}/packages/server/src/routes/identities.ts.
- Parse query params: status, type, limit (default 50, max 100), cursor
- Query D1 database for identities matching filters, scoped to orgId
- Return { data: AgentIdentity[], cursor?: string }
- Sort by createdAt descending
- Use cursor-based pagination (encode last item's id as cursor)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/identities.ts && echo "identities.ts OK" || echo "identities.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/list-identities.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the list identities API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Query param parsing is safe (no SQL injection)
2. Pagination logic is correct with cursor encoding
3. Filters work correctly (status, type)
4. Limit is bounded (max 100)
5. Response shape matches { data: [], cursor?: string }

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/list-identities.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n024 List Identities API: ${result.status}`);
}

main().catch(console.error);
