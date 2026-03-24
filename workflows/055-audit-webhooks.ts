/**
 * 055-audit-webhooks.ts
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

 *
 * Domain 6: Audit & Observability
 * POST /v1/audit/webhooks — notify external systems on events
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

 *
 * Depends on: 051
 * Run: agent-relay run workflows/055-audit-webhooks.ts
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('055-audit-webhooks')
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

  .description('POST /v1/audit/webhooks — notify external systems on events')
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

  .pattern('dag')
  .channel('wf-relayauth-055')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit webhooks system, review output, fix issues',
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for audit webhooks',
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement audit webhooks routes and engine',
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review audit webhooks for quality, consistency, spec compliance',
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit-spec.md`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-audit-logger', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/audit-logger.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-audit-spec', 'read-audit-types', 'read-audit-logger', 'read-test-helpers'],
    task: `Write tests for the audit webhooks system.
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified


Audit spec:
{{steps.read-audit-spec.output}}

Audit types:
{{steps.read-audit-types.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/audit-webhooks.test.ts.
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. POST /v1/audit/webhooks creates a webhook subscription
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

2. GET /v1/audit/webhooks lists webhook subscriptions for an org
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

3. DELETE /v1/audit/webhooks/:id removes a webhook subscription
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

4. Webhook subscription includes: url, events (filter by AuditAction[]), secret
5. dispatchWebhook() sends POST to webhook URL with audit entry payload
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

6. dispatchWebhook() includes HMAC signature header using webhook secret
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

7. dispatchWebhook() retries on 5xx (up to 3 times)
8. Returns 401 without valid auth token
9. Returns 403 without relayauth:audit:manage scope
10. Returns 400 for invalid webhook URL`,
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/audit-webhooks.test.ts && echo "OK" || echo "MISSING"`,
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-logger'],
    task: `Implement the audit webhooks system to make the tests pass.
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified


Audit spec:
{{steps.read-audit-spec.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/routes/audit-webhooks.ts:
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

1. POST /v1/audit/webhooks — create subscription (url, events[], secret)
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

2. GET /v1/audit/webhooks — list subscriptions for org
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

3. DELETE /v1/audit/webhooks/:id — remove subscription
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

4. Store webhooks in D1 audit_webhooks table
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

5. Require auth with relayauth:audit:manage scope

Write to ${ROOT}/packages/server/src/engine/audit-webhook-dispatcher.ts:
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

1. dispatchWebhook(webhook, auditEntry) — POST to webhook URL
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

2. HMAC-SHA256 signature in X-RelayAuth-Signature header
3. Retry on 5xx up to 3 times with exponential backoff
4. Fire-and-forget (don't block the request)

Register routes in the server.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/audit-webhooks.ts && echo "route OK" || echo "route MISSING"; test -f ${ROOT}/packages/server/src/engine/audit-webhook-dispatcher.ts && echo "dispatcher OK" || echo "dispatcher MISSING"`,
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-webhooks.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

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
    task: `Review the audit webhooks implementation.
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover CRUD and dispatch
2. HMAC signature is correctly computed
3. Retry logic uses exponential backoff
4. Webhook dispatch is non-blocking
5. Auth and scope checks are enforced
6. Webhook URL validation prevents SSRF

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-webhooks.test.ts && npx turbo typecheck`,
    - Budget alert webhook: fires when agent hits alertThreshold % of budget
    - Auto-suspend webhook: fires when agent is auto-suspended by budget breach
    - Sponsor notification: webhook includes sponsorId so the human is notified

    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n055 Audit Webhooks: ${result.status}`);
}

main().catch(console.error);
