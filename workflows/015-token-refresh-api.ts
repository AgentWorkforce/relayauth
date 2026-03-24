/**
 * 015-token-refresh-api.ts
 *
 * Domain 2: Token System
 * POST /v1/tokens/refresh — refresh access token
 *
 * Depends on: 014
 * Run: agent-relay run workflows/015-token-refresh-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('015-token-refresh-api')
  .description('POST /v1/tokens/refresh — refresh access token')
  .pattern('dag')
  .channel('wf-relayauth-015')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token refresh API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for token refresh endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement token refresh route and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review token refresh for security, session handling, correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/token-format-spec.md`,
    captureOutput: true,
  })

  .step('read-issuance-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/token-issuance.ts`,
    captureOutput: true,
  })

  .step('read-signing-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/jwt-signing.ts`,
    captureOutput: true,
  })

  .step('read-tokens-route', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/tokens.ts`,
    captureOutput: true,
  })

  .step('read-types', {
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
    dependsOn: ['read-token-spec', 'read-issuance-engine', 'read-types', 'read-test-helpers'],
    task: `Write tests for the token refresh API endpoint.

Token spec:
{{steps.read-token-spec.output}}

Issuance engine:
{{steps.read-issuance-engine.output}}

Token types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/token-refresh.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. POST /v1/tokens/refresh with valid refresh token returns 200 with new TokenPair
2. New access token has fresh exp but same sub, org, wks, scopes
3. New refresh token has same sid (session continuity)
4. Reject expired refresh token — returns 401
5. Reject invalid refresh token (bad signature) — returns 401
6. Reject access token used as refresh token — returns 400
7. Reject missing refreshToken in body — returns 400
8. New access token has updated iat and jti
9. Refresh token rotation: old refresh token is invalidated after use`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/token-refresh.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-refresh', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-issuance-engine', 'read-signing-engine', 'read-tokens-route', 'read-types'],
    task: `Implement the token refresh API.

Issuance engine:
{{steps.read-issuance-engine.output}}

Signing engine:
{{steps.read-signing-engine.output}}

Tokens route:
{{steps.read-tokens-route.output}}

Token types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

1. Create ${ROOT}/packages/server/src/engine/token-refresh.ts:
   - refreshTokenPair(refreshToken: string, signingKey: SigningKey) → TokenPair
   - Decode and verify the refresh token
   - Ensure it has a sid claim (is actually a refresh token)
   - Issue new access + refresh token pair with same identity/scopes
   - Maintain session ID (sid) across refreshes
   - New jti and iat for both tokens

2. Add POST /v1/tokens/refresh handler to ${ROOT}/packages/server/src/routes/tokens.ts
   - Validate request body has refreshToken
   - Call refreshTokenPair
   - Return 200 with new TokenPair

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-refresh'],
    command: `test -f ${ROOT}/packages/server/src/engine/token-refresh.ts && echo "engine OK" || echo "engine MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-refresh.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the token refresh implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Refresh token is verified before issuing new pair
2. Session ID continuity across refreshes
3. Access token cannot be used as refresh token
4. Refresh token rotation is implemented
5. New tokens get fresh jti and iat
6. Proper error handling for expired/invalid tokens
7. Route integrated properly

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-refresh.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n015 Token Refresh API: ${result.status}`);
}

main().catch(console.error);
