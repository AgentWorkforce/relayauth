/**
 * 060-sdk-client-tokens.ts
 *
 * Domain 7: SDK & Verification
 * RelayAuthClient token methods (issue, refresh, revoke)
 *
 * Depends on: 014, 015, 016
 * Run: agent-relay run workflows/060-sdk-client-tokens.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('060-sdk-client-tokens')
  .description('RelayAuthClient token methods (issue, refresh, revoke)')
  .pattern('dag')
  .channel('wf-relayauth-060')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design SDK token methods, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for SDK token methods',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement SDK token methods on RelayAuthClient',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review SDK token methods for correctness and consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/client.ts`,
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

  .step('read-server-token-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/tokens.ts 2>/dev/null || echo "NOT YET CREATED"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-client', 'read-token-types', 'read-errors'],
    task: `Write tests for RelayAuthClient token methods.

Existing client:
{{steps.read-client.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Write failing tests to ${ROOT}/packages/sdk/src/__tests__/client-tokens.test.ts.
Use node:test + node:assert/strict.

Test these methods on RelayAuthClient:
1. issueToken(identityId, options?) — POST /v1/tokens, returns TokenPair
   - options: { scopes?: string[], audience?: string[], expiresIn?: number }
2. refreshToken(refreshToken) — POST /v1/tokens/refresh, returns TokenPair
3. revokeToken(tokenId) — POST /v1/tokens/revoke, returns void
4. introspectToken(token) — GET /v1/tokens/introspect, returns token claims or null

Mock fetch to verify correct URL, method, headers, and body.
Test error cases: expired token, revoked token, invalid identity.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/src/__tests__/client-tokens.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-client', 'read-token-types', 'read-errors'],
    task: `Add token methods to RelayAuthClient.

Existing client:
{{steps.read-client.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Tests to pass:
{{steps.write-tests.output}}

Add these methods to RelayAuthClient in ${ROOT}/packages/sdk/src/client.ts:
- issueToken(identityId: string, options?: { scopes?: string[]; audience?: string[]; expiresIn?: number }): Promise<TokenPair>
- refreshToken(refreshToken: string): Promise<TokenPair>
- revokeToken(tokenId: string): Promise<void>
- introspectToken(token: string): Promise<RelayAuthTokenClaims | null>

Use the existing _request helper (from 059). Map errors appropriately.
Export TokenPair and RelayAuthTokenClaims from package index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/src/client.ts && echo "client.ts OK" || echo "client.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/client-tokens.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the SDK token methods.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/src/client.ts and the test file. Check:
1. All 4 token methods implemented correctly
2. issueToken sends identityId and options in body
3. refreshToken sends the refresh token in body
4. revokeToken sends tokenId correctly
5. introspectToken returns null for invalid tokens (not throwing)
6. Error handling consistent with identity methods
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
cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/client-tokens.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n060 SDK Client Tokens: ${result.status}`);
}

main().catch(console.error);
