/**
 * 082-integration-e2e.ts
 *
 * Domain 9: Integration
 * E2E: agent uses one token to message (relaycast), read files (relayfile), run workflow (cloud)
 *
 * Depends on: 076, 077, 078, 079, 080, 081
 * Run: agent-relay run workflows/082-integration-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('082-integration-e2e')
  .description('Integration E2E: one token across all planes')
  .pattern('pipeline')
  .channel('wf-relayauth-082')
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
    role: 'Write integration E2E test file',
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
    command: `echo "=== RELAYCAST INTEGRATION ===" && cat ${ROOT}/packages/sdk/typescript/src/integrations/relaycast.ts 2>/dev/null || echo "NOT FOUND"; echo "=== RELAYFILE INTEGRATION ===" && cat ${ROOT}/packages/sdk/typescript/src/integrations/relayfile.ts 2>/dev/null || echo "NOT FOUND"; echo "=== CLOUD INTEGRATION ===" && cat ${ROOT}/packages/sdk/typescript/src/integrations/cloud.ts 2>/dev/null || echo "NOT FOUND"; echo "=== CROSS-PLANE ===" && cat ${ROOT}/packages/sdk/typescript/src/integrations/cross-plane.ts 2>/dev/null || echo "NOT FOUND"; echo "=== REVOCATION BROADCAST ===" && cat ${ROOT}/packages/server/src/engine/revocation-broadcast.ts 2>/dev/null || echo "NOT FOUND"; echo "=== PROVISION ===" && cat ${ROOT}/packages/server/src/routes/provision.ts 2>/dev/null || echo "NOT FOUND"`,
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
    task: `Write E2E tests for the full integration domain.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/integration.test.ts.
Use node:test + node:assert/strict. Test the full flow:

1. Create agent identity via relaycast (triggers propagation to relayauth)
2. Mint a multi-scope token: relaycast:channel:read + relayfile:fs:write + cloud:workflow:run
3. Use token to read a relaycast channel — succeeds
4. Use token to write a file via relayfile — succeeds
5. Use token to trigger a cloud workflow — succeeds
6. Use token to write to relaycast channel — fails (only has read)
7. Use token to read relayfile — fails (only has write)
8. Revoke the token in relayauth
9. Verify token is rejected by all three planes
10. Verify audit entries exist for all operations`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/integration.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/integration.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review integration E2E test results.

Results:
{{steps.run-e2e.output}}

Check:
1. All 10 scenarios pass
2. Multi-scope token works across all planes
3. Scope enforcement denies unauthorized actions
4. Revocation propagates to all planes
5. Identity propagation creates correct identity
6. Audit trail is complete
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/integration.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n082 Integration E2E: ${result.status}`);
}

main().catch(console.error);
