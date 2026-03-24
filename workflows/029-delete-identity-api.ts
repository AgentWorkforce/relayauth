/**
 * 029-delete-identity-api.ts
 *
 * Domain 3: Identity Lifecycle
 * DELETE /v1/identities/:id — hard delete (with confirmation)
 *
 * Depends on: 022
 * Run: agent-relay run workflows/029-delete-identity-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('029-delete-identity-api')
  .description('DELETE /v1/identities/:id — hard delete with confirmation')
  .pattern('dag')
  .channel('wf-relayauth-029')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design delete identity API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for delete identity endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement delete identity route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review delete identity API for quality and spec compliance',
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
    task: `Write tests for DELETE /v1/identities/:id endpoint.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/delete-identity.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- DELETE /v1/identities/:id with confirm=true returns 204
- Requires X-Confirm-Delete: true header (returns 400 without it)
- Returns 404 for non-existent identity
- Hard deletes the identity from storage
- GET after delete returns 404
- Revokes all active tokens for the identity
- Can delete identity in any status (active, suspended, retired)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/delete-identity.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-routes'],
    task: `Implement DELETE /v1/identities/:id route.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Tests to pass:
{{steps.write-tests.output}}

Add the DELETE /:id handler to ${ROOT}/packages/server/src/routes/identities.ts.
- Check for X-Confirm-Delete: true header, return 400 if missing
- Return 404 if identity not found
- Revoke all active tokens via REVOCATION_KV
- Call IdentityDO.delete() to remove from storage
- Return 204 (no content)`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/delete-identity.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the delete identity API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Confirmation header is required (safety guard)
2. Hard delete actually removes data from DO storage
3. Token revocation happens before deletion
4. 204 response has no body
5. Works for all identity statuses

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/delete-identity.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n029 Delete Identity API: ${result.status}`);
}

main().catch(console.error);
