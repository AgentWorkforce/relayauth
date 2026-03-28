/**
 * 093-e2e-test-script.ts
 *
 * Domain 11: Testing & CI
 * scripts/e2e.ts — comprehensive smoke test (like relaycast)
 *
 * Depends on: all
 * Run: agent-relay run workflows/093-e2e-test-script.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('093-e2e-test-script')
  .description('scripts/e2e.ts — comprehensive E2E smoke test')
  .pattern('dag')
  .channel('wf-relayauth-093')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E scenarios, fix failures',
    cwd: ROOT,
  })
  .agent('e2e-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the comprehensive E2E test script',
    cwd: ROOT,
  })
  .agent('helper-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E helper utilities and setup/teardown',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage, reliability, and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read ───────────────────────────────────────────────

  .step('read-relaycast-e2e', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/scripts/e2e.ts 2>/dev/null || echo "No relaycast e2e script found"`,
    captureOutput: true,
  })

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-routes', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/server/src/routes -name "*.ts" | sort | xargs -I{} sh -c 'echo "=== {} ===" && head -20 {}'`,
    captureOutput: true,
  })

  .step('read-openapi', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/openapi.yaml 2>/dev/null || cat ${ROOT}/specs/openapi.md 2>/dev/null || echo "No OpenAPI spec found"`,
    captureOutput: true,
  })

  // ── Phase 2: Plan + Write (parallel) ────────────────────────────

  .step('plan-e2e', {
    agent: 'architect',
    dependsOn: ['read-relaycast-e2e', 'read-worker', 'read-sdk-client', 'read-routes', 'read-openapi'],
    task: `Design the comprehensive E2E smoke test script.

Relaycast E2E reference:
{{steps.read-relaycast-e2e.output}}

Worker routes:
{{steps.read-worker.output}}

Routes:
{{steps.read-routes.output}}

Write plan to ${ROOT}/docs/093-e2e-plan.md covering these scenarios:
1. Health check
2. Create org + workspace
3. Create agent identity with scopes
4. Issue token pair
5. Validate token via SDK
6. Check scopes (allow + deny)
7. Refresh token
8. Revoke token, verify revoked
9. Assign role, verify expanded scopes
10. Audit log query
Keep plan under 40 lines. Script runs against local wrangler dev.`,
    verification: { type: 'exit_code' },
  })

  .step('write-e2e-helpers', {
    agent: 'helper-writer',
    dependsOn: ['plan-e2e', 'read-sdk-client'],
    task: `Write E2E helper utilities for scripts/e2e.ts.

Plan:
{{steps.plan-e2e.output}}

SDK client:
{{steps.read-sdk-client.output}}

Write to ${ROOT}/scripts/e2e-helpers.ts:
- BASE_URL constant (default http://localhost:8787)
- request(method, path, body?, token?) helper using fetch
- assert(condition, message) helper
- step(name, fn) helper that logs pass/fail with timing
- setup() that creates org + workspace + admin token
- teardown() that cleans up test data`,
    verification: { type: 'exit_code' },
  })

  .step('write-e2e-script', {
    agent: 'e2e-writer',
    dependsOn: ['plan-e2e', 'read-routes'],
    task: `Write the comprehensive E2E smoke test script.

Plan:
{{steps.plan-e2e.output}}

Routes:
{{steps.read-routes.output}}

Write to ${ROOT}/scripts/e2e.ts:
Import helpers from ./e2e-helpers.js.
Implement all 10 scenarios from the plan as sequential steps.
Each step uses the step() helper for logging.
Exit 0 if all pass, exit 1 if any fail.
Print summary at end: "X/Y passed".`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-e2e-script', 'write-e2e-helpers'],
    command: `test -f ${ROOT}/scripts/e2e.ts && echo "e2e.ts OK" || echo "e2e.ts MISSING"; test -f ${ROOT}/scripts/e2e-helpers.ts && echo "e2e-helpers.ts OK" || echo "e2e-helpers.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('typecheck', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && npx tsc --noEmit scripts/e2e.ts scripts/e2e-helpers.ts 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['typecheck'],
    task: `Review the E2E test script.

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/scripts/e2e.ts and ${ROOT}/scripts/e2e-helpers.ts. Check:
1. All 10 scenarios implemented
2. Proper error handling and cleanup
3. Sequential execution with clear pass/fail reporting
4. Uses SDK client where appropriate
5. Matches relaycast E2E pattern
List issues to fix.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix all issues from the review.

Reviewer feedback:
{{steps.review.output}}

Typecheck results:
{{steps.typecheck.output}}

Fix all issues. Then run:
cd ${ROOT} && npx tsc --noEmit scripts/e2e.ts scripts/e2e-helpers.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n093 E2E Test Script: ${result.status}`);
}

main().catch(console.error);
