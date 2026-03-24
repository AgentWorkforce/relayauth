/**
 * 018-token-introspect-api.ts
 *
 * Domain 2: Token System
 * GET /v1/tokens/introspect — token info without validation
 *
 * Depends on: 014
 * Run: agent-relay run workflows/018-token-introspect-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('018-token-introspect-api')
  .description('GET /v1/tokens/introspect — token info without validation')
  .pattern('dag')
  .channel('wf-relayauth-018')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token introspection API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for token introspection endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement token introspection route and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review token introspection for RFC compliance, security, correctness',
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

  .step('read-revocation-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/token-revocation.ts`,
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
    dependsOn: ['read-token-spec', 'read-issuance-engine', 'read-revocation-engine', 'read-types', 'read-test-helpers'],
    task: `Write tests for the token introspection API endpoint.

Token spec:
{{steps.read-token-spec.output}}

Issuance engine:
{{steps.read-issuance-engine.output}}

Revocation engine:
{{steps.read-revocation-engine.output}}

Token types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/token-introspect.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. POST /v1/tokens/introspect with valid token returns 200 with { active: true, ...claims }
2. Response includes: active, sub, org, wks, scopes, exp, iat, jti, token_type
3. Introspect an expired token — returns { active: false } with claims
4. Introspect a revoked token — returns { active: false, revoked: true }
5. Reject missing token in body — returns 400
6. Introspect does NOT verify signature (just decodes + checks status)
7. Introspect a malformed token — returns 400
8. Response includes issuedAt and expiresAt as ISO timestamps
9. Include revocation info if token is revoked (revokedAt, reason)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/token-introspect.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-introspect', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-issuance-engine', 'read-revocation-engine', 'read-tokens-route', 'read-types'],
    task: `Implement the token introspection API.

Issuance engine:
{{steps.read-issuance-engine.output}}

Revocation engine:
{{steps.read-revocation-engine.output}}

Tokens route:
{{steps.read-tokens-route.output}}

Token types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

1. Create ${ROOT}/packages/server/src/engine/token-introspect.ts:
   - introspectToken(token: string, kv: KVNamespace) → IntrospectionResult
   - Decode token WITHOUT verifying signature (base64url decode only)
   - Check if expired (exp < now)
   - Check if revoked (lookup in REVOCATION_KV)
   - Return { active, ...claims, revoked?, revokedAt?, reason? }

2. IntrospectionResult type:
   { active: boolean, sub?, org?, wks?, scopes?, exp?, iat?, jti?, token_type?, revoked?, revokedAt?, reason? }

3. Add POST /v1/tokens/introspect handler to ${ROOT}/packages/server/src/routes/tokens.ts
   - Validate body has token field
   - Call introspectToken
   - Return 200 with introspection result

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-introspect'],
    command: `test -f ${ROOT}/packages/server/src/engine/token-introspect.ts && echo "engine OK" || echo "engine MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-introspect.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the token introspection implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Introspection does NOT verify signatures (per RFC 7662 pattern)
2. Returns active: false for expired and revoked tokens (not errors)
3. Properly decodes base64url without verification
4. Checks revocation status via KV
5. Response format is consistent and typed
6. No information leakage (don't expose internal errors)
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-introspect.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n018 Token Introspect API: ${result.status}`);
}

main().catch(console.error);
