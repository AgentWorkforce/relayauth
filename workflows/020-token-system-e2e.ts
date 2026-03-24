/**
 * 020-token-system-e2e.ts
 *
 * Domain 2: Token System
 * E2E: issue -> validate -> refresh -> revoke -> verify revoked
 *
 * Depends on: 011, 012, 013, 014, 015, 016, 017, 018, 019
 * Run: agent-relay run workflows/020-token-system-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('020-token-system-e2e')
  .description('Token System E2E tests: issue -> validate -> refresh -> revoke -> verify revoked')
  .pattern('pipeline')
  .channel('wf-relayauth-020')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E test scenarios, fix failures',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E test file for token system',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `echo "=== JWT SIGNING ===" && cat ${ROOT}/packages/server/src/engine/jwt-signing.ts && echo "=== TOKEN ISSUANCE ===" && cat ${ROOT}/packages/server/src/engine/token-issuance.ts && echo "=== TOKEN REFRESH ===" && cat ${ROOT}/packages/server/src/engine/token-refresh.ts && echo "=== TOKEN REVOCATION ===" && cat ${ROOT}/packages/server/src/engine/token-revocation.ts && echo "=== REVOCATION KV ===" && cat ${ROOT}/packages/server/src/engine/revocation-kv.ts && echo "=== TOKEN INTROSPECT ===" && cat ${ROOT}/packages/server/src/engine/token-introspect.ts && echo "=== KEY ROTATION ===" && cat ${ROOT}/packages/server/src/engine/key-rotation.ts && echo "=== TOKENS ROUTE ===" && cat ${ROOT}/packages/server/src/routes/tokens.ts && echo "=== JWKS ROUTE ===" && cat ${ROOT}/packages/server/src/routes/jwks.ts && echo "=== SDK VERIFY ===" && cat ${ROOT}/packages/sdk/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers'],
    task: `Write E2E tests for the entire token system.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/token-system.test.ts.
Use node:test + node:assert/strict.

Test the full token lifecycle flow:

1. "Full token lifecycle: issue -> validate -> refresh -> revoke -> verify revoked"
   - Issue a token pair via POST /v1/tokens
   - Verify the access token is valid (SDK TokenVerifier or manual verification)
   - Fetch JWKS from /.well-known/jwks.json — kid matches token header
   - Refresh the token pair via POST /v1/tokens/refresh
   - Verify new access token is valid
   - Revoke the access token via POST /v1/tokens/revoke
   - Introspect revoked token — should show active: false, revoked: true
   - Attempt to validate revoked token — should fail

2. "Session revocation revokes all tokens in session"
   - Issue a token pair
   - Refresh twice (3 total token pairs, same session)
   - Revoke by session ID
   - All tokens in session should be revoked

3. "Key rotation: tokens signed with old key still valid during grace period"
   - Issue a token with current key
   - Rotate signing key
   - Verify old token still validates (old key in JWKS)
   - Issue new token — signed with new key
   - Both tokens validate successfully

4. "Expired token flow"
   - Create a token with very short TTL (1 second)
   - Wait for expiry
   - Introspect — should show active: false
   - Verify — should fail with TokenExpiredError

5. "Invalid token handling"
   - Introspect a malformed token — returns 400
   - Verify a tampered token — fails with invalid signature
   - Refresh with an access token (not refresh) — fails`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/token-system.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/token-system.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results for the token system.

Results:
{{steps.run-e2e.output}}

Check:
1. All 5 scenarios pass
2. Full lifecycle flow is correct (issue -> validate -> refresh -> revoke)
3. Session revocation is comprehensive
4. Key rotation grace period is tested
5. Error handling scenarios are covered
6. Tests clean up after themselves
7. No flaky timing-dependent tests (except intentional TTL test)

List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures.

Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/token-system.test.ts`,
    verification: { type: 'exit_code' },
  })

  
    // NEW CONCEPTS TO TEST:
    // - Issue token with sponsor -> verify sponsorId and sponsorChain in claims
    // - Issue sub-agent token with parentTokenId -> verify scopes are narrowed
    // - Attempt scope escalation via parentTokenId -> verify 403
    // - Verify no token can be issued without exp (mandatory expiry)
    // - Revoke parent -> verify sub-agent tokens also revoked (cascade)
    // - Issue token with budget -> verify budget claim in JWT

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n020 Token System E2E: ${result.status}`);
}

main().catch(console.error);
