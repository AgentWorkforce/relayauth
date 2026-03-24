/**
 * 076-relaycast-integration.ts
 *
 * Domain 9: Integration
 * relaycast verifies relayauth tokens instead of its own
 *
 * Depends on: 063, 034
 * Run: agent-relay run workflows/076-relaycast-integration.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('076-relaycast-integration')
  .description('Replace relaycast auth with relayauth token verification')
  .pattern('dag')
  .channel('wf-relayauth-076')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan relaycast integration, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests for relaycast token verification',
    cwd: ROOT,
  })
  .agent('impl-relaycast', {
    cli: 'codex',
    preset: 'worker',
    role: 'Modify relaycast auth middleware to use relayauth SDK',
    cwd: RELAYCAST,
  })
  .agent('impl-sdk', {
    cli: 'codex',
    preset: 'worker',
    role: 'Add relaycast middleware adapter to relayauth SDK',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review integration for correctness, backwards compatibility, scope enforcement',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-relaycast-auth', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/middleware/auth.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relaycast-worker', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/worker.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-sdk-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-sdk-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/middleware.ts 2>/dev/null || cat ${ROOT}/packages/server/src/middleware/auth.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-scope-checker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-relaycast-auth', 'read-relaycast-worker', 'read-sdk-verify', 'read-sdk-middleware', 'read-scope-checker'],
    task: `Plan the relaycast integration with relayauth.

Relaycast current auth middleware:
{{steps.read-relaycast-auth.output}}

Relaycast worker:
{{steps.read-relaycast-worker.output}}

RelayAuth SDK verifier:
{{steps.read-sdk-verify.output}}

RelayAuth scope checker:
{{steps.read-scope-checker.output}}

Write a plan to ${ROOT}/docs/076-plan.md covering:
1. How relaycast auth middleware will import @relayauth/sdk
2. Replace existing token validation with TokenVerifier
3. Map relaycast permissions to relayauth scopes (relaycast:channel:read, etc.)
4. Backwards compatibility: support old tokens during migration
5. Files to create/modify in both repos`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-test-helpers'],
    task: `Write integration tests for relaycast + relayauth.

Plan:
{{steps.plan.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/relaycast.test.ts.
Use node:test + node:assert/strict. Test:
1. relayauth token is accepted by relaycast auth middleware
2. Expired token is rejected
3. Token without relaycast scopes is rejected
4. Token with relaycast:channel:read can read channels
5. Token with relaycast:channel:write can send messages`,
    verification: { type: 'exit_code' },
  })

  .step('implement-relaycast-middleware', {
    agent: 'impl-relaycast',
    dependsOn: ['plan', 'read-relaycast-auth'],
    task: `Update relaycast to verify relayauth tokens.

Plan:
{{steps.plan.output}}

Current auth middleware:
{{steps.read-relaycast-auth.output}}

Modify ${RELAYCAST}/packages/server/src/middleware/auth.ts to:
1. Import TokenVerifier from @relayauth/sdk
2. Accept Bearer tokens and verify via relayauth JWKS
3. Extract scopes from verified token claims
4. Attach identity + scopes to request context
5. Keep fallback for legacy tokens during migration`,
    verification: { type: 'exit_code' },
  })

  .step('implement-sdk-adapter', {
    agent: 'impl-sdk',
    dependsOn: ['plan', 'read-sdk-verify', 'read-scope-checker'],
    task: `Add relaycast integration helpers to the SDK.

Plan:
{{steps.plan.output}}

SDK verifier:
{{steps.read-sdk-verify.output}}

Scope checker:
{{steps.read-scope-checker.output}}

Create ${ROOT}/packages/sdk/src/integrations/relaycast.ts:
1. createRelaycastVerifier(opts) — pre-configured TokenVerifier for relaycast
2. RELAYCAST_SCOPES — constants for relaycast scope patterns
3. relaycastScopeCheck(token, action, resource) — check relaycast-specific scopes
Export from ${ROOT}/packages/sdk/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-relaycast-middleware', 'implement-sdk-adapter'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/relaycast.test.ts && echo "test OK" || echo "test MISSING"; test -f ${ROOT}/packages/sdk/src/integrations/relaycast.ts && echo "sdk-adapter OK" || echo "sdk-adapter MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/relaycast.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the relaycast integration.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation files and check:
1. Token verification uses JWKS, not shared secrets
2. Scope mapping is correct (relaycast:channel:read, etc.)
3. Backwards compatibility with legacy tokens
4. No security gaps in the migration path
5. Error responses match relaycast's existing format
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/relaycast.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n076 Relaycast Integration: ${result.status}`);
}

main().catch(console.error);
