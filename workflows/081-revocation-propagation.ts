/**
 * 081-revocation-propagation.ts
 *
 * Domain 9: Integration
 * Agent revoked in relayauth loses access in relaycast + relayfile
 *
 * Depends on: 076, 077, 016
 * Run: agent-relay run workflows/081-revocation-propagation.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('081-revocation-propagation')
  .description('Revoke in relayauth results in lost access everywhere')
  .pattern('dag')
  .channel('wf-relayauth-081')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design revocation propagation, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write revocation propagation tests',
    cwd: ROOT,
  })
  .agent('impl-server', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement revocation broadcast from relayauth',
    cwd: ROOT,
  })
  .agent('impl-planes', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement revocation checking in relaycast and relayfile',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review revocation propagation for security and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-revocation-api', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/tokens.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-revocation-kv', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/revocation.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relaycast-integration', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/integrations/relaycast.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relayfile-integration', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/integrations/relayfile.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-revocation-api', 'read-revocation-kv', 'read-relaycast-integration', 'read-relayfile-integration'],
    task: `Plan revocation propagation across planes.

Revocation API:
{{steps.read-revocation-api.output}}

Revocation KV:
{{steps.read-revocation-kv.output}}

Relaycast integration:
{{steps.read-relaycast-integration.output}}

Relayfile integration:
{{steps.read-relayfile-integration.output}}

Write a plan to ${ROOT}/docs/081-plan.md covering:
1. When token is revoked via POST /v1/tokens/revoke, broadcast to all planes
2. KV-based revocation list checked by each plane's verifier
3. Revocation check in TokenVerifier (SDK already does this via JWKS)
4. Webhook notifications to relaycast + relayfile on revocation
5. Propagation latency: near-instant via KV, eventual via webhook`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-test-helpers'],
    task: `Write revocation propagation tests.

Plan:
{{steps.plan.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/revocation-propagation.test.ts.
Use node:test + node:assert/strict. Test:
1. Token revoked in relayauth is rejected by relaycast verifier
2. Token revoked in relayauth is rejected by relayfile verifier
3. Revocation webhook is sent to registered planes
4. Non-revoked token continues to work after another token is revoked
5. Identity suspension revokes all active tokens for that identity`,
    verification: { type: 'exit_code' },
  })

  .step('implement-broadcast', {
    agent: 'impl-server',
    dependsOn: ['plan', 'read-revocation-api', 'read-revocation-kv'],
    task: `Implement revocation broadcast from relayauth.

Plan:
{{steps.plan.output}}

Revocation API:
{{steps.read-revocation-api.output}}

Revocation KV:
{{steps.read-revocation-kv.output}}

Create ${ROOT}/packages/server/src/engine/revocation-broadcast.ts:
1. broadcastRevocation(tokenId, env) — notify all registered planes
2. Register plane webhook URLs in config (relaycast, relayfile, cloud)
3. Fire webhooks with signed payload (HMAC) for authenticity
4. Write to KV revocation list (already done by 016, wire into broadcast)
5. Handle webhook delivery failures with retry queue
Wire into the token revocation route.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-plane-checking', {
    agent: 'impl-planes',
    dependsOn: ['plan', 'read-relaycast-integration', 'read-relayfile-integration'],
    task: `Add revocation checking to plane integrations.

Plan:
{{steps.plan.output}}

Relaycast integration:
{{steps.read-relaycast-integration.output}}

Relayfile integration:
{{steps.read-relayfile-integration.output}}

Update integration adapters to check revocation:
1. Update ${ROOT}/packages/sdk/typescript/src/integrations/relaycast.ts — add revocation check endpoint
2. Update ${ROOT}/packages/sdk/typescript/src/integrations/relayfile.ts — add revocation check endpoint
3. Create ${ROOT}/packages/sdk/typescript/src/integrations/revocation-webhook.ts:
   - verifyRevocationWebhook(payload, secret) — verify HMAC signature
   - RevocationWebhookHandler — process incoming revocation notifications
   - Add to local revocation cache for fast rejection`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-broadcast', 'implement-plane-checking'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/revocation-propagation.test.ts && echo "test OK" || echo "test MISSING"; test -f ${ROOT}/packages/server/src/engine/revocation-broadcast.ts && echo "broadcast OK" || echo "broadcast MISSING"; test -f ${ROOT}/packages/sdk/typescript/src/integrations/revocation-webhook.ts && echo "webhook OK" || echo "webhook MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/revocation-propagation.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review revocation propagation implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and check:
1. KV revocation propagation is fast (no polling)
2. Webhook payloads are HMAC-signed
3. Revocation of one token doesn't affect others
4. Identity suspension cascades to all tokens
5. No race conditions in revocation checking
List issues to fix.`,
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/revocation-propagation.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n081 Revocation Propagation: ${result.status}`);
}

main().catch(console.error);
