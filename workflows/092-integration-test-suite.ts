/**
 * 092-integration-test-suite.ts
 *
 * Domain 11: Testing & CI
 * Integration tests: server + D1 + KV + DO together
 *
 * Depends on: 083-087
 * Run: agent-relay run workflows/092-integration-test-suite.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('092-integration-test-suite')
  .description('Integration tests: server + D1 + KV + DO together')
  .pattern('dag')
  .channel('wf-relayauth-092')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan integration test scenarios, fix failures',
    cwd: ROOT,
  })
  .agent('test-auth', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests for auth + token flows with D1/KV',
    cwd: ROOT,
  })
  .agent('test-identity', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests for identity lifecycle with DO + D1',
    cwd: ROOT,
  })
  .agent('test-rbac', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests for RBAC + scope enforcement',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review integration test quality, coverage, and isolation',
    cwd: ROOT,
  })

  // ── Phase 1: Read ───────────────────────────────────────────────

  .step('read-wrangler', {
    type: 'deterministic',
    command: `cat ${ROOT}/wrangler.toml`,
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

  .step('read-migrations', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/server/src/db/migrations -name "*.sql" | sort | xargs -I{} sh -c 'echo "=== {} ===" && cat {}'`,
    captureOutput: true,
  })

  .step('read-routes', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/server/src/routes -name "*.ts" | head -10 | xargs -I{} sh -c 'echo "=== {} ===" && head -30 {}'`,
    captureOutput: true,
  })

  // ── Phase 2: Plan + Write (parallel) ────────────────────────────

  .step('plan-integration', {
    agent: 'architect',
    dependsOn: ['read-wrangler', 'read-worker', 'read-test-helpers', 'read-migrations', 'read-routes'],
    task: `Plan integration test scenarios that exercise real bindings.

Wrangler config:
{{steps.read-wrangler.output}}

Worker:
{{steps.read-worker.output}}

Migrations:
{{steps.read-migrations.output}}

Write plan to ${ROOT}/docs/092-integration-plan.md covering:
1. Auth flow: issue token → validate → refresh → revoke (D1 + KV)
2. Identity lifecycle: create → update → suspend → reactivate (DO + D1)
3. RBAC: create role → assign → check scope → policy deny (D1)
Keep under 40 lines.`,
    verification: { type: 'exit_code' },
  })

  .step('write-auth-tests', {
    agent: 'test-auth',
    dependsOn: ['plan-integration', 'read-test-helpers'],
    task: `Write integration tests for auth + token flows.

Plan:
{{steps.plan-integration.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/auth.test.ts.
Use node:test + node:assert/strict. Use createTestApp() with miniflare bindings.
Test: token issuance writes to D1, revocation propagates to KV, JWKS serves keys, refresh rotates tokens.`,
    verification: { type: 'exit_code' },
  })

  .step('write-identity-tests', {
    agent: 'test-identity',
    dependsOn: ['plan-integration', 'read-test-helpers'],
    task: `Write integration tests for identity lifecycle.

Plan:
{{steps.plan-integration.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/identity.test.ts.
Use node:test + node:assert/strict. Use createTestApp().
Test: create identity persists in DO, suspend revokes tokens, retire prevents reauth, list/search queries D1.`,
    verification: { type: 'exit_code' },
  })

  .step('write-rbac-tests', {
    agent: 'test-rbac',
    dependsOn: ['plan-integration', 'read-test-helpers'],
    task: `Write integration tests for RBAC + scope enforcement.

Plan:
{{steps.plan-integration.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/rbac.test.ts.
Use node:test + node:assert/strict. Use createTestApp().
Test: role creation persists, role assignment grants scopes, policy deny overrides allow, scope inheritance from org to workspace.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-auth-tests', 'write-identity-tests', 'write-rbac-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/auth.test.ts && echo "auth OK" || echo "auth MISSING"; test -f ${ROOT}/packages/server/src/__tests__/integration/identity.test.ts && echo "identity OK" || echo "identity MISSING"; test -f ${ROOT}/packages/server/src/__tests__/integration/rbac.test.ts && echo "rbac OK" || echo "rbac MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/*.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
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
    task: `Review the integration test suite.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read all three integration test files. Check:
1. Tests use real bindings (D1/KV/DO), not unit mocks
2. Proper test isolation (cleanup between tests)
3. Cross-binding interactions verified (e.g., revoke updates both D1 and KV)
4. Error scenarios tested
List issues to fix.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix all issues from the review.

Reviewer feedback:
{{steps.review.output}}

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Fix all issues. Then run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/*.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n092 Integration Test Suite: ${result.status}`);
}

main().catch(console.error);
