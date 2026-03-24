/**
 * 080-identity-propagation.ts
 *
 * Domain 9: Integration
 * Agent created in relaycast auto-created in relayauth
 *
 * Depends on: 076
 * Run: agent-relay run workflows/080-identity-propagation.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('080-identity-propagation')
  .description('Agent created in relaycast is auto-created in relayauth')
  .pattern('dag')
  .channel('wf-relayauth-080')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design identity propagation, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write identity propagation tests',
    cwd: ROOT,
  })
  .agent('impl-relaycast', {
    cli: 'codex',
    preset: 'worker',
    role: 'Add identity propagation webhook to relaycast',
    cwd: RELAYCAST,
  })
  .agent('impl-server', {
    cli: 'codex',
    preset: 'worker',
    role: 'Add identity provisioning endpoint to relayauth server',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review identity propagation for consistency and idempotency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-relaycast-agents', {
    type: 'deterministic',
    command: `find ${RELAYCAST}/packages/server/src -name "*agent*" -o -name "*identity*" | head -5 | xargs cat 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relayauth-identity-api', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/identities.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-identity-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/client.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-relaycast-agents', 'read-relayauth-identity-api', 'read-identity-types', 'read-sdk-client'],
    task: `Plan identity propagation from relaycast to relayauth.

Relaycast agent creation:
{{steps.read-relaycast-agents.output}}

Relayauth identity API:
{{steps.read-relayauth-identity-api.output}}

Identity types:
{{steps.read-identity-types.output}}

SDK client:
{{steps.read-sdk-client.output}}

Write a plan to ${ROOT}/docs/080-plan.md covering:
1. When agent is created in relaycast, call relayauth POST /v1/identities
2. Map relaycast agent fields to relayauth identity fields
3. Idempotent creation (if identity exists, update instead)
4. Default scopes for new agents (relaycast:channel:read)
5. Webhook from relaycast to relayauth on agent create/update`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-test-helpers'],
    task: `Write identity propagation tests.

Plan:
{{steps.plan.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/identity-propagation.test.ts.
Use node:test + node:assert/strict. Test:
1. Agent created in relaycast triggers relayauth identity creation
2. Duplicate agent creation is idempotent (no error, returns existing)
3. Agent update in relaycast updates relayauth identity
4. Created identity has correct default scopes
5. Failed propagation does not block relaycast agent creation`,
    verification: { type: 'exit_code' },
  })

  .step('implement-relaycast-webhook', {
    agent: 'impl-relaycast',
    dependsOn: ['plan', 'read-relaycast-agents'],
    task: `Add identity propagation to relaycast.

Plan:
{{steps.plan.output}}

Current agent code:
{{steps.read-relaycast-agents.output}}

Modify relaycast to:
1. After agent creation, call relayauth to create identity
2. Use RelayAuthClient from @relayauth/sdk
3. Map agent fields: name, type, orgId, workspaceId
4. Fire-and-forget with retry (don't block agent creation)
5. Log propagation failures for observability`,
    verification: { type: 'exit_code' },
  })

  .step('implement-provision-endpoint', {
    agent: 'impl-server',
    dependsOn: ['plan', 'read-relayauth-identity-api', 'read-identity-types'],
    task: `Add identity provisioning support to relayauth.

Plan:
{{steps.plan.output}}

Identity API:
{{steps.read-relayauth-identity-api.output}}

Identity types:
{{steps.read-identity-types.output}}

Create ${ROOT}/packages/server/src/routes/provision.ts:
1. POST /v1/provision/identity — upsert identity from external plane
2. Accept source plane identifier (relaycast, relayfile, cloud)
3. Idempotent: if identity with external ID exists, update metadata
4. Assign default scopes based on source plane
5. Return the relayauth identity with its ID
Wire into the server router.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-relaycast-webhook', 'implement-provision-endpoint'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/identity-propagation.test.ts && echo "test OK" || echo "test MISSING"; test -f ${ROOT}/packages/server/src/routes/provision.ts && echo "provision OK" || echo "provision MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/identity-propagation.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review identity propagation implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and check:
1. Idempotent upsert works correctly
2. External ID mapping prevents duplicates
3. Default scopes are appropriate per source plane
4. Fire-and-forget doesn't lose data (retry/queue)
5. No auth bypass in the provision endpoint
List issues to fix.`,
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/identity-propagation.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n080 Identity Propagation: ${result.status}`);
}

main().catch(console.error);
