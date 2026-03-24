/**
 * 012-jwks-endpoint.ts
 *
 * Domain 2: Token System
 * GET /.well-known/jwks.json — public key publishing
 *
 * Depends on: 011
 * Run: agent-relay run workflows/012-jwks-endpoint.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('012-jwks-endpoint')
  .description('GET /.well-known/jwks.json — public key publishing')
  .pattern('dag')
  .channel('wf-relayauth-012')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design JWKS endpoint, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for JWKS endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement JWKS endpoint route',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review JWKS endpoint for correctness, caching, spec compliance',
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

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-token-spec', 'read-signing-engine', 'read-types', 'read-test-helpers'],
    task: `Write tests for the JWKS endpoint.

Token spec:
{{steps.read-token-spec.output}}

Signing engine:
{{steps.read-signing-engine.output}}

Token types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/jwks-endpoint.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. GET /.well-known/jwks.json returns 200 with { keys: [...] }
2. Response Content-Type is application/json
3. Each key has kty, kid, alg, use: "sig", and key material (n, e for RSA or x, crv for EdDSA)
4. Cache-Control header is set (max-age=3600 or similar)
5. Keys array contains current active signing key
6. Keys array includes rotated (previous) keys still within grace period
7. Response matches JWKSResponse type from @relayauth/types`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/jwks-endpoint.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-jwks', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-signing-engine', 'read-worker', 'read-types'],
    task: `Implement the JWKS endpoint.

Signing engine:
{{steps.read-signing-engine.output}}

Current worker:
{{steps.read-worker.output}}

Token types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

1. Create ${ROOT}/packages/server/src/routes/jwks.ts:
   - Export a Hono route handler for GET /.well-known/jwks.json
   - Use exportPublicJWK from the signing engine to build the keys array
   - Include current key + any rotated keys within grace period
   - Set Cache-Control: public, max-age=3600
   - Return { keys: [...] } matching JWKSResponse type

2. Register the route in ${ROOT}/packages/server/src/worker.ts

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-jwks'],
    command: `test -f ${ROOT}/packages/server/src/routes/jwks.ts && echo "jwks OK" || echo "jwks MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/jwks-endpoint.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the JWKS endpoint implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Follows RFC 7517 (JWK Set format)
2. Cache-Control is set for public caching
3. Keys include kid, alg, use, kty fields
4. Route is properly registered in worker.ts
5. No private key material is exposed
6. Handles empty key set gracefully

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/jwks-endpoint.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n012 JWKS Endpoint: ${result.status}`);
}

main().catch(console.error);
