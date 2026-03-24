/**
 * 085-identity-do-complete.ts
 *
 * Domain 10: Hosted Server
 * IdentityDO: full implementation with SQLite storage
 *
 * Depends on: 021
 * Run: agent-relay run workflows/085-identity-do-complete.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('085-identity-do-complete')
  .description('IdentityDO: full Durable Object implementation with SQLite storage')
  .pattern('dag')
  .channel('wf-relayauth-085')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design IdentityDO internals, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for IdentityDO',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement IdentityDO with SQLite storage',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review IdentityDO for correctness and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ──────────────────────────────────────────

  .step('read-identity-do', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/durable-objects/identity-do.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-do', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/durable-objects/AgentDO.ts 2>/dev/null | head -100`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-identity-do', 'read-types', 'read-test-helpers'],
    task: `Write tests for IdentityDO.

Existing DO scaffold:
{{steps.read-identity-do.output}}

Types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write ${ROOT}/packages/server/src/__tests__/identity-do.test.ts:
- Test SQLite table creation on init
- Test create identity (stores in SQLite)
- Test get identity by ID
- Test update identity fields
- Test suspend/reactivate/retire lifecycle
- Test scope assignment storage
- Test metadata storage
- Test lastActiveAt tracking
Use node:test + node:assert/strict.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/identity-do.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ────────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-identity-do', 'read-types', 'read-relaycast-do'],
    task: `Implement the complete IdentityDO.

Existing scaffold:
{{steps.read-identity-do.output}}

Types:
{{steps.read-types.output}}

Relaycast DO pattern:
{{steps.read-relaycast-do.output}}

Write ${ROOT}/packages/server/src/durable-objects/identity-do.ts:
- Extend DurableObject with SQLite storage
- initializeStorage(): create identities table in DO SQLite
- handleRequest(request): route GET/POST/PATCH/DELETE
- create(input): insert identity, return AgentIdentity
- get(): read identity from SQLite
- update(fields): partial update
- suspend(reason): set status=suspended
- reactivate(): set status=active
- retire(): set status=retired (permanent)
- updateLastActive(): touch lastActiveAt
- assignScopes(scopes): store scopes as JSON
Export from worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/durable-objects/identity-do.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/identity-do.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review IdentityDO implementation.

Test results:
{{steps.run-tests.output}}

Typecheck:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. SQLite schema matches AgentIdentity type
2. All lifecycle transitions are handled
3. Error handling for invalid transitions
4. Proper JSON serialization for scopes/metadata
5. Follows relaycast DO patterns
List issues.`,
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

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/identity-do.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n085 IdentityDO Complete: ${result.status}`);
}

main().catch(console.error);
