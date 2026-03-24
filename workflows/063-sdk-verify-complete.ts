/**
 * 063-sdk-verify-complete.ts
 *
 * Domain 7: SDK & Verification
 * TokenVerifier: full implementation with JWKS fetching, caching
 *
 * Depends on: 013
 * Run: agent-relay run workflows/063-sdk-verify-complete.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('063-sdk-verify-complete')
  .description('TokenVerifier: full implementation with JWKS fetching, caching')
  .pattern('dag')
  .channel('wf-relayauth-063')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design complete TokenVerifier, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write comprehensive tests for TokenVerifier',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement full TokenVerifier with JWKS fetching and caching',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review TokenVerifier for security, correctness, and edge cases',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/errors.ts`,
    captureOutput: true,
  })

  .step('read-scopes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-existing-tests', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/__tests__/verify.test.ts 2>/dev/null || echo "no existing tests"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-verify', 'read-token-types', 'read-errors', 'read-scopes'],
    task: `Write comprehensive tests for the complete TokenVerifier.

Existing verify scaffold:
{{steps.read-verify.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Scopes:
{{steps.read-scopes.output}}

Write tests to ${ROOT}/packages/sdk/src/__tests__/verify-complete.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. verify(token) — decodes JWT, fetches JWKS, verifies signature, returns claims
2. JWKS caching — second verify call uses cached keys (mock fetch, assert call count)
3. JWKS cache expiry — after TTL, re-fetches JWKS
4. Key rotation — kid in token header selects correct key from JWKS
5. Expired token — throws TokenExpiredError
6. Invalid signature — throws RelayAuthError
7. Wrong audience — throws RelayAuthError
8. Wrong issuer — throws RelayAuthError
9. verifyAndCheckScope(token, requiredScope) — verify + scope check
10. Revocation check — if checkRevocation option enabled, calls revocation endpoint

Use a mock JWKS server (mock global fetch). Create test JWTs with known keys.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/src/__tests__/verify-complete.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-verify', 'read-token-types', 'read-errors', 'read-scopes'],
    task: `Implement the complete TokenVerifier in ${ROOT}/packages/sdk/src/verify.ts.

Existing scaffold:
{{steps.read-verify.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Scopes:
{{steps.read-scopes.output}}

Tests to pass:
{{steps.write-tests.output}}

Implement TokenVerifier with:
- constructor(options?: VerifyOptions) — jwksUrl, issuer, audience, maxAge, cacheTtlMs
- verify(token: string): Promise<RelayAuthTokenClaims> — full JWT verification
- verifyAndCheckScope(token: string, requiredScope: string): Promise<RelayAuthTokenClaims>

Internal implementation:
- _fetchJwks() — fetch JWKS from jwksUrl, cache with TTL (default 5 min)
- _findKey(kid: string) — find key in cached JWKS by kid
- _decodeHeader(token: string) — base64url decode JWT header for kid/alg
- _verifySignature(token: string, key: CryptoKey) — use Web Crypto API
- _validateClaims(claims: any) — check exp, iss, aud

Use Web Crypto API (SubtleCrypto) for RS256/EdDSA verification.
Zero external dependencies. Export from package index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/src/verify.ts && echo "verify.ts OK" || echo "verify.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/verify-complete.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the complete TokenVerifier implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/src/verify.ts and the test file. Check:
1. JWT verification uses Web Crypto API correctly
2. JWKS caching works with TTL
3. Key selection by kid is correct
4. All claim validations: exp, iss, aud
5. No external dependencies (zero-dep requirement)
6. Error types match: TokenExpiredError, RelayAuthError
7. Scope checking integrates with ScopeChecker
8. Security: timing-safe comparison, no algorithm confusion
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
cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/verify-complete.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n063 SDK Verify Complete: ${result.status}`);
}

main().catch(console.error);
