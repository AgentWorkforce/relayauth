/**
 * 087-key-management-complete.ts
 *
 * Domain 10: Hosted Server
 * Signing key storage, rotation, JWKS serving from KV
 *
 * Depends on: 019
 * Run: agent-relay run workflows/087-key-management-complete.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('087-key-management-complete')
  .description('Signing key storage, rotation, JWKS serving from KV')
  .pattern('dag')
  .channel('wf-relayauth-087')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design key management strategy, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for key management',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement key storage, rotation, and JWKS serving',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review key management for security and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ──────────────────────────────────────────

  .step('read-key-rotation', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/key-rotation.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-jwks', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/jwks.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-key-rotation', 'read-jwks', 'read-env', 'read-test-helpers'],
    task: `Write tests for key management.

Existing key rotation:
{{steps.read-key-rotation.output}}

JWKS route:
{{steps.read-jwks.output}}

Env:
{{steps.read-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write ${ROOT}/packages/server/src/__tests__/key-management.test.ts:
- Test generateSigningKey creates RS256 key pair
- Test storeKeyInKV persists key with metadata
- Test getActiveKey returns current signing key
- Test rotateKey creates new key, marks old as retired
- Test grace period (old key still valid during rotation)
- Test JWKS endpoint returns all active public keys
- Test JWKS caching headers
- Test key ID format and uniqueness
Use node:test + node:assert/strict.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/key-management.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ────────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-key-rotation', 'read-jwks', 'read-env'],
    task: `Implement complete key management.

Existing key rotation:
{{steps.read-key-rotation.output}}

JWKS route:
{{steps.read-jwks.output}}

Env:
{{steps.read-env.output}}

Write ${ROOT}/packages/server/src/engine/key-management.ts:
- generateSigningKey(): create RS256 key pair using Web Crypto
- storeKey(kv, keyId, privateKey, publicKey): store in KV
- getActiveKey(kv): get current signing key
- rotateKey(kv): create new key, mark old with grace period
- getJWKS(kv): return all active public keys as JWKS
- KV keys: "signing:active", "signing:{keyId}:private", "signing:{keyId}:public"
- Grace period: 24 hours after rotation
- Key format: JWK with kid, kty, alg, use fields
Export from engine index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/key-management.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/key-management.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review key management implementation.

Test results:
{{steps.run-tests.output}}

Typecheck:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Web Crypto API usage is correct for CF Workers
2. Private keys never appear in JWKS response
3. Grace period logic prevents token validation failures
4. Key ID generation is unique and deterministic
5. KV storage format is efficient
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/key-management.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n087 Key Management Complete: ${result.status}`);
}

main().catch(console.error);
