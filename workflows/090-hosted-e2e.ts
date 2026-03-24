/**
 * 090-hosted-e2e.ts
 *
 * Domain 10: Hosted Server
 * E2E against staging: full flow including KV propagation timing
 *
 * Depends on: 088
 * Run: agent-relay run workflows/090-hosted-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('090-hosted-e2e')
  .description('Hosted server E2E: full flow against staging including KV propagation timing')
  .pattern('pipeline')
  .channel('wf-relayauth-090')
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
    role: 'Write E2E test file for hosted server',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ─────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/worker.ts && echo "=== ENV ===" && cat ${ROOT}/packages/server/src/env.ts && echo "=== REVOCATION ===" && cat ${ROOT}/packages/server/src/engine/revocation.ts 2>/dev/null | head -40 && echo "=== KEY MGMT ===" && cat ${ROOT}/packages/server/src/engine/key-management.ts 2>/dev/null | head -40`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-e2e', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/scripts/e2e.ts 2>/dev/null | head -80`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers', 'read-relaycast-e2e'],
    task: `Write E2E tests for the hosted server.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Relaycast E2E pattern:
{{steps.read-relaycast-e2e.output}}

Write ${ROOT}/packages/server/src/__tests__/e2e/hosted-server.test.ts:

Test the full hosted flow:
1. Health check — GET /health returns 200
2. Create identity — POST /v1/identities
3. Issue token — POST /v1/tokens for created identity
4. Validate token — verify JWT with JWKS endpoint
5. Check JWKS — GET /.well-known/jwks.json returns keys
6. Revoke token — POST /v1/tokens/revoke
7. Verify revocation in KV — token validation fails after revoke
8. KV propagation timing — revocation visible within 1s
9. Create role + assign — POST /v1/roles, assign to identity
10. Scope enforcement — request with insufficient scope returns 403
11. Audit trail — GET /v1/audit shows all above operations

Use node:test + node:assert/strict.
Each test should be independent where possible.
Include timing assertions for KV propagation.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/hosted-server.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ─────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/hosted-server.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
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
1. All scenarios pass or have clear failure reasons
2. KV propagation timing is tested
3. Full lifecycle covered (create → token → revoke → verify)
4. RBAC and scope enforcement tested
5. Audit trail completeness verified
6. Proper cleanup between tests
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/hosted-server.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n090 Hosted E2E: ${result.status}`);
}

main().catch(console.error);
