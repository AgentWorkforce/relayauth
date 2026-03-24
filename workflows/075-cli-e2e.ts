/**
 * 075-cli-e2e.ts
 *
 * Domain 8: CLI
 * E2E: full CLI flow — login → create agent → assign role → check access
 *
 * Depends on: 069, 070, 071, 072, 073, 074
 * Run: agent-relay run workflows/075-cli-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('075-cli-e2e')
  .description('CLI E2E tests')
  .pattern('pipeline')
  .channel('wf-relayauth-075')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E test scenarios, fix failures',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E test file',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/src/lib/cli.ts && echo "=== LOGIN ===" && cat ${ROOT}/packages/cli/src/commands/login.ts && echo "=== AGENT ===" && cat ${ROOT}/packages/cli/src/commands/agent.ts && echo "=== TOKEN ===" && cat ${ROOT}/packages/cli/src/commands/token.ts && echo "=== ROLE ===" && cat ${ROOT}/packages/cli/src/commands/role.ts && echo "=== AUDIT ===" && cat ${ROOT}/packages/cli/src/commands/audit.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers'],
    task: `Write E2E tests for the CLI domain.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/cli/src/__tests__/e2e/cli.test.ts.
Use node:test + node:assert/strict.

Test the full CLI flow:
1. Login with API key → verify credentials stored
2. Create agent identity via CLI → verify returned identity
3. List agents → verify new agent appears
4. Get agent by ID → verify details match
5. Create role with scopes → verify role created
6. Assign role to agent → verify assignment
7. Issue token for agent → verify token pair returned
8. Introspect issued token → verify claims contain assigned scopes
9. Revoke token → verify revocation succeeds
10. Suspend agent → verify status changed
11. Query audit log → verify actions appear
12. Logout → verify credentials cleared

Mock the SDK client for unit-level E2E (no live server needed).
Each test should set up its own state and clean up after.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/e2e/cli.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/e2e/cli.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results.

Results:
{{steps.run-e2e.output}}

Check:
1. All 12 scenarios pass
2. Full lifecycle flow is tested (login → create → assign → token → revoke → suspend → audit → logout)
3. Edge cases covered (invalid credentials, missing identity, etc.)
4. Proper cleanup between tests
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures.

Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/e2e/cli.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n075 CLI E2E: ${result.status}`);
}

main().catch(console.error);
