/**
 * 036-role-assignment-api.ts
 *
 * Domain 4: Scopes & RBAC
 * POST /v1/identities/:id/roles — assign/remove roles
 *
 * Depends on: 035, 022
 * Run: agent-relay run workflows/036-role-assignment-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('036-role-assignment-api')
  .description('POST /v1/identities/:id/roles — assign/remove roles')
  .pattern('dag')
  .channel('wf-relayauth-036')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design role assignment API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for role assignment API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement role assignment routes and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review role assignment API for correctness and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-rbac-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/rbac.md`,
    captureOutput: true,
  })

  .step('read-role-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/roles.ts`,
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

  .step('read-identity-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/identities.ts 2>/dev/null || echo "No identity routes yet"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-rbac-spec', 'read-role-engine', 'read-identity-types', 'read-test-helpers'],
    task: `Write tests for the role assignment API.

RBAC spec:
{{steps.read-rbac-spec.output}}

Role engine:
{{steps.read-role-engine.output}}

Identity types:
{{steps.read-identity-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/role-assignment.test.ts.
Use node:test + node:assert/strict. Import from test-helpers.js.

Test these behaviors:
1. POST /v1/identities/:id/roles — assigns a role to an identity
2. POST /v1/identities/:id/roles — returns 404 if identity not found
3. POST /v1/identities/:id/roles — returns 404 if role not found
4. POST /v1/identities/:id/roles — returns 409 if role already assigned
5. DELETE /v1/identities/:id/roles/:roleId — removes role from identity
6. DELETE /v1/identities/:id/roles/:roleId — returns 404 if not assigned
7. GET /v1/identities/:id/roles — lists all roles for an identity
8. Assigning a role updates the identity's roles array
9. Removing a role updates the identity's roles array
10. Cannot assign roles across different orgs`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/role-assignment.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-role-engine', 'read-identity-types', 'read-identity-routes'],
    task: `Implement the role assignment API to make the tests pass.

Role engine:
{{steps.read-role-engine.output}}

Identity types:
{{steps.read-identity-types.output}}

Identity routes:
{{steps.read-identity-routes.output}}

Tests to pass:
{{steps.write-tests.output}}

Create/update these files:

1. ${ROOT}/packages/server/src/engine/role-assignments.ts:
   - assignRole(db, identityId, roleId, orgId): Promise<void>
   - removeRole(db, identityId, roleId): Promise<void>
   - listIdentityRoles(db, identityId): Promise<Role[]>
   - Validate identity exists and is in same org as role

2. ${ROOT}/packages/server/src/routes/role-assignments.ts:
   - POST /v1/identities/:id/roles — { roleId: string }
   - DELETE /v1/identities/:id/roles/:roleId
   - GET /v1/identities/:id/roles

Register in worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/role-assignments.ts && echo "engine OK" || echo "engine MISSING"; test -f ${ROOT}/packages/server/src/routes/role-assignments.ts && echo "routes OK" || echo "routes MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/role-assignment.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the role assignment API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Org isolation is enforced — cross-org assignment prevented
2. Identity existence is validated before assignment
3. Role existence is validated before assignment
4. Duplicate assignment returns 409, not silent success
5. D1 queries use proper join table for many-to-many relationship

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/role-assignment.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n036 Role Assignment API: ${result.status}`);
}

main().catch(console.error);
