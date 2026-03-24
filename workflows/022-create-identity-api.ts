/**
 * 022-create-identity-api.ts
 *
 * Domain 3: Identity Lifecycle
 * POST /v1/identities — create agent identity
 *
 * Depends on: 021
 * Run: agent-relay run workflows/022-create-identity-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('022-create-identity-api')
  .description('POST /v1/identities — create agent identity')
  .pattern('dag')
  .channel('wf-relayauth-022')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design create identity API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for create identity endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement create identity route and handler',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review create identity API for quality and spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-identity-do', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/durable-objects/identity-do.ts`,
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
    dependsOn: ['read-types', 'read-identity-do', 'read-test-helpers'],
    task: `Write tests for POST /v1/identities endpoint.

Identity types:
{{steps.read-types.output}}

IdentityDO:
{{steps.read-identity-do.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/create-identity.test.ts.
    - sponsor field is REQUIRED in CreateIdentityInput — no identity without a human sponsor
    - sponsorChain auto-populated: if created by another agent, chain = parent.chain + [parentId]
    - budget optional, defaults to org-level budget if not set

Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- POST /v1/identities with valid body returns 201 with identity object
- Returns identity with generated id (agent_xxx format), status "active", timestamps
- Validates required field: name (returns 400 if missing)
- Defaults type to "agent" if not provided
- Accepts optional scopes, roles, metadata, workspaceId
- Returns 409 if identity with same name already exists in org
- Sets orgId from authenticated context`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/create-identity.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-identity-do', 'read-worker'],
    task: `Implement POST /v1/identities route.

Identity types:
{{steps.read-types.output}}

IdentityDO:
{{steps.read-identity-do.output}}

Worker:
{{steps.read-worker.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/routes/identities.ts with the create handler.
- Validate input (name required, type defaults to "agent")
- Generate id with "agent_" prefix + random string
- Call IdentityDO to store the identity
- Return 201 with the created identity
    - sponsor field is REQUIRED in CreateIdentityInput — no identity without a human sponsor
    - sponsorChain auto-populated: if created by another agent, chain = parent.chain + [parentId]
    - budget optional, defaults to org-level budget if not set

- Wire the route into the Hono app in worker.ts.`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/create-identity.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the create identity API implementation.
    - sponsor field is REQUIRED in CreateIdentityInput — no identity without a human sponsor
    - sponsorChain auto-populated: if created by another agent, chain = parent.chain + [parentId]
    - budget optional, defaults to org-level budget if not set


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Input validation is thorough (name required, type enum)
2. ID generation uses crypto-safe random
3. IdentityDO integration is correct
4. Response matches CreateIdentityInput/AgentIdentity types
5. Route is properly wired into worker.ts

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/create-identity.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n022 Create Identity API: ${result.status}`);
}

main().catch(console.error);
