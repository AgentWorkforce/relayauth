/**
 * 016-token-revocation-api.ts
 *
 * Domain 2: Token System
 * POST /v1/tokens/revoke — revoke token, propagate to KV
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

 *
 * Depends on: 014
 * Run: agent-relay run workflows/016-token-revocation-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('016-token-revocation-api')
  .description('POST /v1/tokens/revoke — revoke token, propagate to KV')
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

  .pattern('dag')
  .channel('wf-relayauth-016')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token revocation API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for token revocation endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement token revocation route and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review token revocation for correctness, KV propagation, security',
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

  .step('read-tokens-route', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/tokens.ts`,
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
    dependsOn: ['read-token-spec', 'read-issuance-engine', 'read-env', 'read-test-helpers'],
    task: `Write tests for the token revocation API endpoint.

Token spec:
{{steps.read-token-spec.output}}

Issuance engine:
{{steps.read-issuance-engine.output}}

Server env (has REVOCATION_KV):
{{steps.read-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/token-revocation.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. POST /v1/tokens/revoke with valid token returns 200
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

2. Revoked token's jti is written to KV (REVOCATION_KV)
3. KV entry has TTL matching token's remaining lifetime
4. Revoke by token string — decodes jti from the token
5. Revoke by jti directly — accepts { jti: "tok_xxxx" }
6. Reject missing token and jti in body — returns 400
7. Revoking an already-revoked token is idempotent (returns 200)
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

8. Revoke propagates to KV with metadata (revokedAt, reason)
9. Revoke with optional reason field
10. Revoking a session (by sid) revokes all tokens in that session`,
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/token-revocation.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-revocation', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-spec', 'read-issuance-engine', 'read-tokens-route', 'read-env'],
    task: `Implement the token revocation API.

Token spec:
{{steps.read-token-spec.output}}

Issuance engine:
{{steps.read-issuance-engine.output}}

Tokens route:
{{steps.read-tokens-route.output}}

Server env:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

1. Create ${ROOT}/packages/server/src/engine/token-revocation.ts:
   - revokeToken(params: { token?: string, jti?: string, sid?: string, reason?: string }, kv: KVNamespace) → { revoked: true, jti: string }
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

   - Decode token to extract jti if token string provided
   - Write jti to REVOCATION_KV with TTL = remaining token lifetime
   - Store metadata: { revokedAt, reason }
   - isRevoked(jti: string, kv: KVNamespace) → boolean
   - Support session-level revocation (revoke by sid)

2. Add POST /v1/tokens/revoke handler to ${ROOT}/packages/server/src/routes/tokens.ts
    - Revocation CASCADES to all sub-agent tokens (via parentTokenId chain)
    - When parent is revoked, all children are revoked in the same KV write

   - Validate body has token OR jti
   - Call revokeToken engine
   - Return 200 with { revoked: true, jti }

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-revocation'],
    command: `test -f ${ROOT}/packages/server/src/engine/token-revocation.ts && echo "engine OK" || echo "engine MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-revocation.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the token revocation implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. KV write includes appropriate TTL (not indefinite)
2. Idempotent revocation (no error on double-revoke)
3. Session-level revocation covers all session tokens
4. Proper error handling for malformed tokens
5. isRevoked check is efficient (single KV get)
6. No sensitive data in KV values
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-revocation.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n016 Token Revocation API: ${result.status}`);
}

main().catch(console.error);
