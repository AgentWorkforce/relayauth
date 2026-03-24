/**
 * 025-update-identity-api.ts
 *
 * Domain 3: Identity Lifecycle
 * PATCH /v1/identities/:id — update metadata, scopes
 *
 * Depends on: 022
 * Run: agent-relay run workflows/025-update-identity-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('025-update-identity-api')
  .description('PATCH /v1/identities/:id — update metadata, scopes')
  .pattern('dag')
  .channel('wf-relayauth-025')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design update identity API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for update identity endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement update identity route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review update identity API for quality and spec compliance',
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
    task: `Write tests for PATCH /v1/identities/:id endpoint.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/update-identity.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- PATCH /v1/identities/:id with name update returns 200 with updated identity
- Updates metadata (merge, not replace)
- Updates scopes (replace entire array)
- Updates name
- Sets updatedAt to current time
- Returns 404 for non-existent identity
- Returns 400 for empty body
- Cannot update id, orgId, createdAt (immutable fields ignored)
- Can update a suspended identity's metadata`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/update-identity.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-routes'],
    task: `Implement PATCH /v1/identities/:id route.

Identity types:
{{steps.read-types.output}}

Existing routes:
{{steps.read-routes.output}}

Tests to pass:
{{steps.write-tests.output}}

Add the PATCH /:id handler to ${ROOT}/packages/server/src/routes/identities.ts.
- Extract id from route params, parse JSON body
- Return 400 if body is empty
- Return 404 if identity not found
- Call IdentityDO.update() with allowed fields only
- Metadata is merged (Object.assign), scopes replace entirely
- Ignore immutable fields: id, orgId, createdAt
- Return 200 with the full updated identity`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/update-identity.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the update identity API implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Metadata merge vs scopes replace logic is correct
2. Immutable fields are properly protected
3. updatedAt is set on every update
4. 404 and 400 error handling is consistent
5. Works correctly for suspended identities

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/update-identity.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n025 Update Identity API: ${result.status}`);
}

main().catch(console.error);
