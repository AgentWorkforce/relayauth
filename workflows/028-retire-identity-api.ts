/**
 * 028-retire-identity-api.ts
 *
 * Domain 3: Identity Lifecycle
 * POST /v1/identities/:id/retire — permanent deactivation
 *
 * Depends on: 026
 * Run: agent-relay run workflows/028-retire-identity-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('028-retire-identity-api')
  .description('POST /v1/identities/:id/retire — permanent deactivation')
  .pattern('dag')
  .channel('wf-relayauth-028')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design retire identity API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for retire identity endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement retire identity route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review retire identity API for quality and spec compliance',
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
    task: `Write tests for POST /v1/identities/:id/retire endpoint.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/retire-identity.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- POST /v1/identities/:id/retire returns 200 with updated identity
- Sets status to "retired" permanently
- Accepts optional reason in body
- Returns 404 for non-existent identity
- Returns 409 if identity is already retired
- Can retire an active identity directly
- Can retire a suspended identity
- Revokes all active tokens for the identity
- Retired identity cannot be reactivated (tested via 027)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/retire-identity.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-routes'],
    task: `Implement POST /v1/identities/:id/retire route.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Tests to pass:
{{steps.write-tests.output}}

Add the POST /:id/retire handler to ${ROOT}/packages/server/src/routes/identities.ts.
- Return 404 if identity not found
- Return 409 if already retired
- Accept optional reason in body
- Call IdentityDO.retire() to set status "retired"
- Revoke all active tokens via REVOCATION_KV
- Return 200 with the updated identity`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/retire-identity.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the retire identity API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Retirement is permanent (no path back to active)
2. Both active and suspended identities can be retired
3. Token revocation is triggered
4. Optional reason is handled correctly
5. Consistent with suspend endpoint patterns

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/retire-identity.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n028 Retire Identity API: ${result.status}`);
}

main().catch(console.error);
