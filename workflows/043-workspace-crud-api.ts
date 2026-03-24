/**
 * 043-workspace-crud-api.ts
 *
 * Domain 5: API Routes
 * /v1/workspaces — create, read, update, list workspaces
 *
 * Depends on: 042
 * Run: agent-relay run workflows/043-workspace-crud-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('043-workspace-crud-api')
  .description('/v1/workspaces — create, read, update, list workspaces')
  .pattern('dag')
  .channel('wf-relayauth-043')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design workspace CRUD API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for workspace CRUD API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement workspace CRUD routes',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review workspace CRUD API for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-org-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/organizations.ts`,
    captureOutput: true,
  })

  .step('read-auth-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/middleware/auth.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-org-routes', 'read-auth-middleware', 'read-env', 'read-test-helpers'],
    task: `Write tests for the workspace CRUD API.

Org routes (reference pattern):
{{steps.read-org-routes.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/workspace-crud.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. POST /v1/workspaces — creates workspace under org (201)
2. GET /v1/workspaces/:id — returns workspace (200)
3. GET /v1/workspaces/:id — returns 404 for unknown
4. PATCH /v1/workspaces/:id — updates workspace (200)
5. GET /v1/workspaces?orgId=X — lists workspaces for org
6. Workspace must belong to caller's org (403)
7. All routes require auth (401 without token)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/workspace-crud.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-org-routes', 'read-auth-middleware', 'read-env'],
    task: `Implement workspace CRUD routes to make the tests pass.

Org routes (follow same pattern):
{{steps.read-org-routes.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/routes/workspaces.ts:
1. POST /v1/workspaces — create workspace in D1, link to org
2. GET /v1/workspaces/:id — read workspace
3. PATCH /v1/workspaces/:id — update workspace
4. GET /v1/workspaces — list by orgId query param
Enforce org ownership. Wire into worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/workspaces.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/workspace-crud.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the workspace CRUD API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Org ownership enforcement is correct
2. D1 queries are parameterized
3. Pattern is consistent with org routes
4. Workspace-org relationship is properly modeled
5. List endpoint supports orgId filtering

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/workspace-crud.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n043 Workspace CRUD API: ${result.status}`);
}

main().catch(console.error);
