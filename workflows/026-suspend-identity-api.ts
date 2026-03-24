/**
 * 026-suspend-identity-api.ts
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

 *
 * Domain 3: Identity Lifecycle
 * POST /v1/identities/:id/suspend — suspend with reason
 *
 * Depends on: 022, 016
 * Run: agent-relay run workflows/026-suspend-identity-api.ts
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('026-suspend-identity-api')
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

  .description('POST /v1/identities/:id/suspend — suspend with reason')
  .pattern('dag')
  .channel('wf-relayauth-026')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design suspend identity API, review output, fix issues',
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for suspend identity endpoint',
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement suspend identity route',
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review suspend identity API for quality and spec compliance',
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

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

  .step('read-identity-do', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/durable-objects/identity-do.ts`,
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
    task: `Write tests for POST /v1/identities/:id/suspend endpoint.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/suspend-identity.test.ts.
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- POST /v1/identities/:id/suspend with reason returns 200
- Sets status to "suspended", sets suspendedAt and suspendReason
- Requires reason field in body (returns 400 if missing)
- Returns 404 for non-existent identity
- Returns 409 if identity is already suspended
- Returns 409 if identity is retired (cannot suspend retired)
- Revokes all active tokens for the identity (calls revocation)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/suspend-identity.test.ts && echo "OK" || echo "MISSING"`,
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-routes', 'read-identity-do'],
    task: `Implement POST /v1/identities/:id/suspend route.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

IdentityDO:
{{steps.read-identity-do.output}}

Tests to pass:
{{steps.write-tests.output}}

Add the POST /:id/suspend handler to ${ROOT}/packages/server/src/routes/identities.ts.
- Validate reason is provided in body
- Return 404 if identity not found
- Return 409 if already suspended or retired
- Call IdentityDO.suspend(reason) to update state
- Revoke active tokens via REVOCATION_KV binding
- Return 200 with updated identity`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/suspend-identity.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

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
    task: `Review the suspend identity API implementation.
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Status transition validation (only active -> suspended)
2. Reason is required and stored
3. suspendedAt timestamp is set
4. Token revocation is triggered
5. Error responses use consistent format

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/suspend-identity.test.ts && npx turbo typecheck`,
    - Auto-suspend triggered by budget breach (not just manual)
    - Suspend CASCADES to all sub-agents spawned by this identity
    - Audit event includes: reason (manual | budget_exceeded | parent_suspended)

    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n026 Suspend Identity API: ${result.status}`);
}

main().catch(console.error);
