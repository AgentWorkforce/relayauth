/**
 * 086-kv-revocation-complete.ts
 *
 * Domain 10: Hosted Server
 * KV revocation: write on revoke, check on validate, TTL cleanup
 *
 * Depends on: 017
 * Run: agent-relay run workflows/086-kv-revocation-complete.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('086-kv-revocation-complete')
  .description('KV revocation: write on revoke, check on validate, TTL cleanup')
  .pattern('dag')
  .channel('wf-relayauth-086')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design KV revocation strategy, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for KV revocation',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement KV revocation with TTL cleanup',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review KV revocation for correctness and edge cases',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ──────────────────────────────────────────

  .step('read-revocation', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/revocation.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-revocation', 'read-env', 'read-token-types', 'read-test-helpers'],
    task: `Write tests for KV revocation.

Existing revocation code:
{{steps.read-revocation.output}}

Env types:
{{steps.read-env.output}}

Token types:
{{steps.read-token-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write ${ROOT}/packages/server/src/__tests__/kv-revocation.test.ts:
- Test revokeToken writes jti to KV with TTL
- Test isRevoked returns true for revoked token
- Test isRevoked returns false for non-revoked token
- Test TTL matches token expiry time
- Test batch revocation (revoke all tokens for identity)
- Test revocation survives KV eventual consistency
- Test cleanup of expired revocation entries
Use node:test + node:assert/strict with mockKV().`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/kv-revocation.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ────────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-revocation', 'read-env'],
    task: `Implement complete KV revocation.

Existing code:
{{steps.read-revocation.output}}

Env:
{{steps.read-env.output}}

Write ${ROOT}/packages/server/src/engine/revocation.ts:
- revokeToken(kv, jti, expiresAt): write to KV with TTL
- isRevoked(kv, jti): check if token is revoked
- revokeAllForIdentity(kv, identityId, tokenIds): batch revoke
- KV key format: "revoked:{jti}"
- TTL = token expiry - now (auto-cleanup)
- Handle KV write failures gracefully
Export from engine index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/revocation.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/kv-revocation.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review KV revocation implementation.

Test results:
{{steps.run-tests.output}}

Typecheck:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. TTL calculation is correct (token expiry - now)
2. KV key format prevents collisions
3. Batch revocation handles partial failures
4. No race conditions in check-then-write
5. Consistent with token revocation API (workflow 016)
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/kv-revocation.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n086 KV Revocation Complete: ${result.status}`);
}

main().catch(console.error);
