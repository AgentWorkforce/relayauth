/**
 * 044-workspace-membership-api.ts
 *
 * Domain 5: API Routes
 * /v1/workspaces/:id/members — add/remove identities
 *
 * Depends on: 043, 022
 * Run: agent-relay run workflows/044-workspace-membership-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('044-workspace-membership-api')
  .description('/v1/workspaces/:id/members — add/remove identities')
  .pattern('dag')
  .channel('wf-relayauth-044')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design workspace membership API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for workspace membership API',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement workspace membership routes',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review workspace membership API for quality and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-workspace-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/workspaces.ts`,
    captureOutput: true,
  })

  .step('read-identity-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-auth-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/middleware/auth.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-workspace-routes', 'read-identity-types', 'read-auth-middleware', 'read-test-helpers'],
    task: `Write tests for the workspace membership API.

Workspace routes:
{{steps.read-workspace-routes.output}}

Identity types:
{{steps.read-identity-types.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/workspace-membership.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. POST /v1/workspaces/:id/members — adds identity to workspace (201)
2. DELETE /v1/workspaces/:id/members/:identityId — removes member (200)
3. GET /v1/workspaces/:id/members — lists workspace members
4. Cannot add identity from different org (403)
5. Cannot add non-existent identity (404)
6. Cannot add duplicate member (409)
7. Requires auth token (401)
8. Requires workspace manage scope (403)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/workspace-membership.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-workspace-routes', 'read-identity-types', 'read-auth-middleware'],
    task: `Implement workspace membership routes to make the tests pass.

Workspace routes:
{{steps.read-workspace-routes.output}}

Identity types:
{{steps.read-identity-types.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Tests to pass:
{{steps.write-tests.output}}

Add to ${ROOT}/packages/server/src/routes/workspaces.ts (or a new members sub-route):
1. POST /v1/workspaces/:id/members — add identity to workspace
2. DELETE /v1/workspaces/:id/members/:identityId — remove member
3. GET /v1/workspaces/:id/members — list members
Use D1 junction table. Validate org ownership and identity existence.`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/workspace-membership.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the workspace membership API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Junction table design is correct
2. Org boundary enforcement prevents cross-org membership
3. Duplicate member detection works
4. Scope checking for manage permission
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/workspace-membership.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n044 Workspace Membership API: ${result.status}`);
}

main().catch(console.error);
