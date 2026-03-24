/**
 * 013-token-verification.ts
 *
 * Domain 2: Token System
 * Zero-dep JWT verification library (SDK)
 *
 * Depends on: 011, 012
 * Run: agent-relay run workflows/013-token-verification.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('013-token-verification')
  .description('Zero-dep JWT verification library (SDK)')
  .pattern('dag')
  .channel('wf-relayauth-013')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token verification library, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for token verification',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement token verification in SDK package',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review token verification for security, zero-dep compliance, correctness',
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

  .step('read-sdk-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-sdk-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/errors.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-token-spec', 'read-signing-engine', 'read-sdk-verify', 'read-sdk-errors', 'read-types'],
    task: `Write tests for the JWT verification library in the SDK package.

Token spec:
{{steps.read-token-spec.output}}

Signing engine (for creating test tokens):
{{steps.read-signing-engine.output}}

SDK verify scaffold:
{{steps.read-sdk-verify.output}}

SDK errors:
{{steps.read-sdk-errors.output}}

Token types:
{{steps.read-types.output}}

Write failing tests to ${ROOT}/packages/sdk/src/__tests__/verify.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. Verify a valid RS256-signed token — returns decoded claims
2. Verify a valid EdDSA-signed token — returns decoded claims
3. Reject an expired token — throws TokenExpiredError
4. Reject a token with invalid signature — throws error
5. Reject a malformed token (not 3 parts) — throws error
6. Reject a token with unknown kid — throws error
7. Verify with issuer check — reject mismatched issuer
8. Verify with audience check — reject mismatched audience
9. Fetch JWKS from URL and cache keys
10. Re-fetch JWKS when kid not found in cache (key rotation support)
11. Verify returns typed RelayAuthTokenClaims`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/src/__tests__/verify.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-verify', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-spec', 'read-sdk-verify', 'read-sdk-errors', 'read-types'],
    task: `Implement the JWT verification library in the SDK package.

Token spec:
{{steps.read-token-spec.output}}

SDK verify scaffold:
{{steps.read-sdk-verify.output}}

SDK errors:
{{steps.read-sdk-errors.output}}

Token types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Replace ${ROOT}/packages/sdk/src/verify.ts with full implementation:

1. TokenVerifier class with options: { jwksUrl, issuer, audience, maxAge }
2. verify(token: string): Promise<RelayAuthTokenClaims>
   - Decode header (base64url) to get kid and alg
   - Decode payload (base64url) to get claims
   - Fetch public key by kid from JWKS (with cache)
   - Verify signature using Web Crypto API
   - Check exp (reject if expired)
   - Check iss (if issuer option set)
   - Check aud (if audience option set)
   - Return typed claims
3. JWKS fetching with in-memory cache and configurable TTL
4. Re-fetch on cache miss (supports key rotation)
5. Zero external dependencies — Web Crypto API + fetch only
6. Base64url decode helpers (no Buffer)
7. Throw appropriate errors from @relayauth/sdk/errors

Export TokenVerifier and VerifyOptions from SDK index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-verify'],
    command: `test -f ${ROOT}/packages/sdk/src/verify.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/verify.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the token verification library.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Zero external dependencies (only Web Crypto + fetch)
2. Works in CF Workers, Node.js, and browsers
3. Correct RS256 and EdDSA signature verification
4. Proper base64url decoding without Buffer
5. JWKS caching with rotation support
6. Throws correct error types (TokenExpiredError, etc.)
7. No timing attack vulnerabilities in signature comparison
8. Types exported from SDK index

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
cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/verify.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n013 Token Verification: ${result.status}`);
}

main().catch(console.error);
