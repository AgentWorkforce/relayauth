/**
 * 042-org-crud-api.ts
 *
 * Domain 5: API Routes
 * /v1/organizations — create, read, update organizations
 *
 * Depends on: 041
 * Run: agent-relay run workflows/042-org-crud-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('042-org-crud-api')
  .description('/v1/organizations — create, read, update organizations')
  .pattern('dag')
  .channel('wf-relayauth-042')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design org CRUD API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for org CRUD API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement org CRUD routes and DB layer',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review org CRUD API for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

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

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-auth-middleware', 'read-env', 'read-worker', 'read-test-helpers'],
    task: `Write tests for the org CRUD API.

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Worker:
{{steps.read-worker.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/org-crud.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. POST /v1/organizations — creates org, returns 201 with org object
2. GET /v1/organizations/:id — returns org by ID (200)
3. GET /v1/organizations/:id — returns 404 for unknown org
4. PATCH /v1/organizations/:id — updates org name/metadata (200)
5. GET /v1/organizations — lists orgs for authenticated identity
6. All routes require valid auth token (401 without)
7. Validates required fields on create (400 for missing name)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/org-crud.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-auth-middleware', 'read-env', 'read-worker'],
    task: `Implement org CRUD routes to make the tests pass.

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Worker:
{{steps.read-worker.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/routes/organizations.ts:
1. POST /v1/organizations — create org in D1
2. GET /v1/organizations/:id — read org from D1
3. PATCH /v1/organizations/:id — update org in D1
4. GET /v1/organizations — list orgs
Use Hono router. Apply auth middleware. Validate inputs.
Wire routes into the main worker.ts app.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/organizations.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/org-crud.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the org CRUD API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. D1 queries are parameterized (no SQL injection)
2. Auth middleware is applied to all routes
3. Input validation rejects invalid payloads
4. Response format is consistent
5. Routes are properly wired into worker.ts

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/org-crud.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n042 Org CRUD API: ${result.status}`);
}

main().catch(console.error);
