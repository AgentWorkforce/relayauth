/**
 * 079-cross-plane-scope-check.ts
 *
 * Domain 9: Integration
 * Agent with relaycast:read + relayfile:write — verify each plane enforces scopes
 *
 * Depends on: 076, 077
 * Run: agent-relay run workflows/079-cross-plane-scope-check.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('079-cross-plane-scope-check')
  .description('Verify each plane enforces its own scopes from a multi-scope token')
  .pattern('dag')
  .channel('wf-relayauth-079')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design cross-plane scope enforcement tests, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write cross-plane scope enforcement tests',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement scope enforcement validation helpers',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope enforcement for security and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-relaycast-integration', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/integrations/relaycast.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relayfile-integration', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/integrations/relayfile.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-scope-checker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-relaycast-integration', 'read-relayfile-integration', 'read-scope-checker', 'read-scope-types'],
    task: `Plan cross-plane scope enforcement verification.

Relaycast integration:
{{steps.read-relaycast-integration.output}}

Relayfile integration:
{{steps.read-relayfile-integration.output}}

Scope checker:
{{steps.read-scope-checker.output}}

Scope types:
{{steps.read-scope-types.output}}

Write a plan to ${ROOT}/docs/079-plan.md covering:
1. Token with relaycast:channel:read + relayfile:fs:write
2. Relaycast allows read but denies write
3. Relayfile allows write but denies read-only scoped requests
4. Each plane only checks its own plane prefix
5. Cross-plane scope isolation — no scope leakage between planes`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-test-helpers'],
    task: `Write cross-plane scope enforcement tests.

Plan:
{{steps.plan.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/cross-plane-scope.test.ts.
Use node:test + node:assert/strict. Test:
1. Token with relaycast:channel:read — accepted by relaycast, rejected by relayfile
2. Token with relayfile:fs:write — accepted by relayfile, rejected by relaycast
3. Token with both scopes — accepted by both for correct actions
4. Token with relaycast:channel:read cannot write to relaycast
5. Token with cloud:workflow:run — rejected by both relaycast and relayfile
6. Wildcard scope relaycast:*:*:* only grants relaycast access, not relayfile`,
    verification: { type: 'exit_code' },
  })

  .step('implement-validator', {
    agent: 'implementer',
    dependsOn: ['plan', 'read-scope-checker', 'read-scope-types'],
    task: `Implement cross-plane scope validation helpers.

Plan:
{{steps.plan.output}}

Scope checker:
{{steps.read-scope-checker.output}}

Scope types:
{{steps.read-scope-types.output}}

Create ${ROOT}/packages/sdk/src/integrations/cross-plane.ts:
1. validatePlaneScope(token, plane) — checks token has any scope for given plane
2. enforcePlaneIsolation(token, plane, action, resource) — strict per-plane check
3. getEffectiveScopesForPlane(token, plane) — extract scopes for a specific plane
4. PLANE_REGISTRY — map of plane names to their scope prefixes
Export from ${ROOT}/packages/sdk/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-validator'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/cross-plane-scope.test.ts && echo "test OK" || echo "test MISSING"; test -f ${ROOT}/packages/sdk/src/integrations/cross-plane.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/cross-plane-scope.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review cross-plane scope enforcement.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Each plane only accepts its own scoped tokens
2. Wildcard scopes are plane-bounded (relaycast:*:*:* != relayfile:*)
3. No scope confusion between planes
4. Empty scope list is properly rejected
5. Invalid plane names are handled
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/cross-plane-scope.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n079 Cross-Plane Scope Check: ${result.status}`);
}

main().catch(console.error);
