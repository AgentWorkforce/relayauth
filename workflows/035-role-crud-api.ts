/**
 * 035-role-crud-api.ts
 *
 * Domain 4: Scopes & RBAC
 * /v1/roles — create, read, update, delete roles
 *
 * Depends on: 005, 022
 * Run: agent-relay run workflows/035-role-crud-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('035-role-crud-api')
  .description('/v1/roles — create, read, update, delete roles')
  .pattern('dag')
  .channel('wf-relayauth-035')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design role CRUD API routes, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for role CRUD API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement role CRUD routes and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review role CRUD API for correctness and REST best practices',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-rbac-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/rbac.md`,
    captureOutput: true,
  })

  .step('read-rbac-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/rbac.ts`,
    captureOutput: true,
  })

  .step('read-server-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
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

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-rbac-spec', 'read-rbac-types', 'read-test-helpers', 'read-server-env'],
    task: `Write tests for the role CRUD API.

RBAC spec:
{{steps.read-rbac-spec.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Server env:
{{steps.read-server-env.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/role-crud.test.ts.
Use node:test + node:assert/strict. Import from test-helpers.js.

Test these behaviors:
1. POST /v1/roles — creates a role with name, description, scopes
2. POST /v1/roles — returns 400 for missing required fields
3. POST /v1/roles — returns 409 for duplicate role name in same org
4. GET /v1/roles/:id — returns role by ID
5. GET /v1/roles/:id — returns 404 for nonexistent role
6. GET /v1/roles — lists all roles for the org
7. GET /v1/roles?workspaceId=ws_xxx — filters by workspace
8. PATCH /v1/roles/:id — updates role name, description, scopes
9. PATCH /v1/roles/:id — returns 403 for built-in roles
10. DELETE /v1/roles/:id — deletes role, returns 403 for built-in roles`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/role-crud.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-engine', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-rbac-spec', 'read-rbac-types', 'read-server-env'],
    task: `Implement the role engine and routes to make the tests pass.

RBAC spec:
{{steps.read-rbac-spec.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Server env:
{{steps.read-server-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Create these files:

1. ${ROOT}/packages/server/src/engine/roles.ts:
   - createRole(db: D1Database, input): Promise<Role>
   - getRole(db: D1Database, id: string): Promise<Role | null>
   - listRoles(db: D1Database, orgId: string, workspaceId?: string): Promise<Role[]>
   - updateRole(db: D1Database, id: string, updates): Promise<Role>
   - deleteRole(db: D1Database, id: string): Promise<void>
   - Validate scopes format using scope parser
   - Prevent modification of built-in roles

2. ${ROOT}/packages/server/src/routes/roles.ts:
   - Hono router with POST/GET/PATCH/DELETE /v1/roles routes
   - Use role engine functions
   - Return proper HTTP status codes and JSON responses

Register routes in worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-engine'],
    command: `test -f ${ROOT}/packages/server/src/engine/roles.ts && echo "engine OK" || echo "engine MISSING"; test -f ${ROOT}/packages/server/src/routes/roles.ts && echo "routes OK" || echo "routes MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/role-crud.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the role CRUD API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. REST conventions followed (proper status codes, resource URIs)
2. Built-in roles are protected from modification/deletion
3. Scope validation on role creation/update
4. Org isolation — roles from one org can't be accessed by another
5. D1 queries are parameterized (no SQL injection)

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/role-crud.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n035 Role CRUD API: ${result.status}`);
}

main().catch(console.error);
