/**
 * 011-jwt-signing.ts
 *
 * Domain 2: Token System
 * RS256/EdDSA JWT signing with key ID rotation support
 *
 * Depends on: 003
 * Run: agent-relay run workflows/011-jwt-signing.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('011-jwt-signing')
  .description('RS256/EdDSA JWT signing with key ID rotation support')
  .pattern('dag')
  .channel('wf-relayauth-011')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design JWT signing engine, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for JWT signing module',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement JWT signing engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review JWT signing for security, correctness, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/token-format-spec.md`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-server-env', {
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
    dependsOn: ['read-token-spec', 'read-types', 'read-test-helpers'],
    task: `Write tests for JWT signing engine.

Token format spec:
{{steps.read-token-spec.output}}

Token types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/jwt-signing.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. Sign a JWT with RS256 — returns valid JWT string with 3 parts
2. Sign a JWT with EdDSA — returns valid JWT string
3. Signed JWT header contains correct alg and kid
4. Signed JWT payload contains all required claims (sub, org, wks, scopes, iss, aud, exp, iat, jti)
5. Sign with key rotation — new kid after rotation
6. Reject signing with expired key
7. Sign with custom claims (meta field)
8. Generate a keypair for RS256
9. Generate a keypair for EdDSA
10. Export public key in JWK format`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/jwt-signing.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-signing', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-spec', 'read-types', 'read-server-env'],
    task: `Implement JWT signing engine.

Token format spec:
{{steps.read-token-spec.output}}

Token types:
{{steps.read-types.output}}

Server env:
{{steps.read-server-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/engine/jwt-signing.ts:

1. SigningKey interface: { kid, alg, privateKey, publicKey, createdAt, expiresAt }
2. generateKeyPair(alg: 'RS256' | 'EdDSA') — uses Web Crypto API
3. signToken(claims: RelayAuthTokenClaims, key: SigningKey) — returns signed JWT string
4. exportPublicJWK(key: SigningKey) — exports public key as JWK with kid
5. Use Web Crypto API only (CF Workers compatible, zero external deps)
6. Base64url encoding helpers (no Buffer — use Uint8Array)
7. JWT format: header.payload.signature (standard)

Export all functions. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-signing'],
    command: `test -f ${ROOT}/packages/server/src/engine/jwt-signing.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/jwt-signing.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the JWT signing implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Uses Web Crypto API only (no Node.js crypto) for CF Workers compat
2. RS256 and EdDSA both work correctly
3. Key ID (kid) is included in JWT header
4. All required claims are in the payload
5. Base64url encoding is correct (no padding, URL-safe chars)
6. No security vulnerabilities (timing attacks, weak randomness)
7. Types are properly exported

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/jwt-signing.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n011 JWT Signing: ${result.status}`);
}

main().catch(console.error);
