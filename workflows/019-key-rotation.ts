/**
 * 019-key-rotation.ts
 *
 * Domain 2: Token System
 * Automated signing key rotation with grace period
 *
 * Depends on: 011, 012
 * Run: agent-relay run workflows/019-key-rotation.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('019-key-rotation')
  .description('Automated signing key rotation with grace period')
  .pattern('dag')
  .channel('wf-relayauth-019')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design key rotation system, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for key rotation',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement key rotation engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review key rotation for security, grace period handling, JWKS consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/token-format-spec.md`,
    captureOutput: true,
  })

  .step('read-signing-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/jwt-signing.ts`,
    captureOutput: true,
  })

  .step('read-jwks-route', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/jwks.ts`,
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
    dependsOn: ['read-token-spec', 'read-signing-engine', 'read-jwks-route', 'read-test-helpers'],
    task: `Write tests for the key rotation system.

Token spec:
{{steps.read-token-spec.output}}

Signing engine:
{{steps.read-signing-engine.output}}

JWKS route:
{{steps.read-jwks-route.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/key-rotation.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. rotateSigningKey() generates a new key pair and sets it as active
2. Previous key moves to "rotated" status with grace period
3. Tokens signed with old key are still valid during grace period
4. JWKS endpoint includes both current and grace-period keys
5. Expired grace-period keys are removed from JWKS
6. KeyManager tracks active key, rotated keys, and their expiry
7. getActiveSigningKey() always returns the current key
8. getAllPublicKeys() returns active + grace-period keys
9. Key rotation stores keys in KV for persistence
10. Grace period is configurable (default: 24 hours)
11. Key metadata includes kid, alg, createdAt, rotatedAt, expiresAt`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/key-rotation.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-rotation', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-signing-engine', 'read-jwks-route', 'read-env'],
    task: `Implement the key rotation system.

Signing engine:
{{steps.read-signing-engine.output}}

JWKS route:
{{steps.read-jwks-route.output}}

Server env:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/engine/key-rotation.ts:

1. KeyManager class:
   - constructor(kv: KVNamespace, options?: { gracePeriodMs?: number, algorithm?: 'RS256' | 'EdDSA' })
   - initialize(): Promise<void> — load keys from KV or generate first key
   - getActiveSigningKey(): SigningKey — returns current active key
   - getAllPublicKeys(): JsonWebKey[] — active + grace-period keys as JWK
   - rotateSigningKey(): Promise<SigningKey> — generate new, retire old
   - cleanupExpiredKeys(): Promise<number> — remove expired grace-period keys

2. Key lifecycle: active → rotated (grace period) → expired (removed)

3. KV storage:
   - "signing:active" → serialized active key
   - "signing:rotated:{kid}" → serialized rotated key with expiry
   - "signing:keys" → list of all kid values

4. Grace period default: 24 hours (configurable)

5. Update JWKS route to use KeyManager.getAllPublicKeys()

Export KeyManager. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-rotation'],
    command: `test -f ${ROOT}/packages/server/src/engine/key-rotation.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/key-rotation.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the key rotation implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Key rotation is atomic (no window where no key is active)
2. Grace period allows existing tokens to validate
3. JWKS endpoint properly serves all valid keys
4. KV persistence handles concurrent access safely
5. Private keys are never exposed through public APIs
6. Key cleanup removes expired keys from both memory and KV
7. Algorithm selection is consistent across rotation

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/key-rotation.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n019 Key Rotation: ${result.status}`);
}

main().catch(console.error);
