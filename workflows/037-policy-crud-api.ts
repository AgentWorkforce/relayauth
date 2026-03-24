/**
 * 037-policy-crud-api.ts
 *
 * Domain 4: Scopes & RBAC
 * /v1/policies — create, read, update, delete policies
 *
 * Depends on: 005
 * Run: agent-relay run workflows/037-policy-crud-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('037-policy-crud-api')
  .description('/v1/policies — create, read, update, delete policies')
  .pattern('dag')
  .channel('wf-relayauth-037')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design policy CRUD API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for policy CRUD API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement policy CRUD routes and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review policy CRUD API for correctness and REST best practices',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-rbac-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/rbac-spec.md`,
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

  .step('read-role-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/roles.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-rbac-spec', 'read-rbac-types', 'read-test-helpers', 'read-server-env', 'read-role-engine'],
    task: `Write tests for the policy CRUD API.

RBAC spec:
{{steps.read-rbac-spec.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Server env:
{{steps.read-server-env.output}}

Role engine (for pattern reference):
{{steps.read-role-engine.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/policy-crud.test.ts.
Use node:test + node:assert/strict. Import from test-helpers.js.

Test these behaviors:
1. POST /v1/policies — creates policy with name, effect, scopes, conditions, priority
2. POST /v1/policies — returns 400 for missing required fields
3. POST /v1/policies — validates effect is "allow" or "deny"
4. POST /v1/policies — validates conditions format
5. GET /v1/policies/:id — returns policy by ID
6. GET /v1/policies/:id — returns 404 for nonexistent policy
7. GET /v1/policies — lists all policies for the org, ordered by priority
8. PATCH /v1/policies/:id — updates policy fields
9. PATCH /v1/policies/:id — validates scope format on update
10. DELETE /v1/policies/:id — soft-deletes policy`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/policy-crud.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-rbac-spec', 'read-rbac-types', 'read-server-env', 'read-role-engine'],
    task: `Implement the policy CRUD API to make the tests pass.

RBAC spec:
{{steps.read-rbac-spec.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Server env:
{{steps.read-server-env.output}}

Role engine (for pattern reference):
{{steps.read-role-engine.output}}

Tests to pass:
{{steps.write-tests.output}}

Create these files:

1. ${ROOT}/packages/server/src/engine/policies.ts:
   - createPolicy(db, input): Promise<Policy>
   - getPolicy(db, id): Promise<Policy | null>
   - listPolicies(db, orgId, workspaceId?): Promise<Policy[]>
   - updatePolicy(db, id, updates): Promise<Policy>
   - deletePolicy(db, id): Promise<void>
   - Validate conditions format
   - Validate scope strings using scope parser
   - Order by priority descending

2. ${ROOT}/packages/server/src/routes/policies.ts:
   - Hono router with POST/GET/PATCH/DELETE /v1/policies
   - Return proper HTTP status codes and JSON responses

Register in worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/policies.ts && echo "engine OK" || echo "engine MISSING"; test -f ${ROOT}/packages/server/src/routes/policies.ts && echo "routes OK" || echo "routes MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/policy-crud.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the policy CRUD API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Policy conditions are validated properly
2. Priority ordering is correct (higher first)
3. Scope strings validated on create/update
4. Org isolation enforced
5. Consistent with role CRUD patterns

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/policy-crud.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n037 Policy CRUD API: ${result.status}`);
}

main().catch(console.error);
