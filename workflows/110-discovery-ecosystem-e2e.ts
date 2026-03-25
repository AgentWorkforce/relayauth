/**
 * 110-discovery-ecosystem-e2e.ts
 *
 * Domain 13: Discovery & Ecosystem
 * E2E: discovery + framework adapters + OpenAPI scopes + A2A bridge
 *
 * Depends on: 101-109
 * Run: agent-relay run workflows/110-discovery-ecosystem-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('110-discovery-ecosystem-e2e')
  .description('E2E tests for discovery, framework adapters, and A2A bridge')
  .pattern('pipeline')
  .channel('wf-relayauth-110')
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
    command: `echo "=== Discovery Route ===" && cat ${ROOT}/packages/server/src/routes/discovery.ts 2>/dev/null | head -40 || echo "NOT FOUND"; echo "=== Adapter Base ===" && cat ${ROOT}/packages/ai/src/adapter.ts 2>/dev/null | head -40 || echo "NOT FOUND"; echo "=== OpenAPI Scopes ===" && cat ${ROOT}/packages/sdk/src/openapi-scopes.ts 2>/dev/null | head -40 || echo "NOT FOUND"; echo "=== A2A Bridge ===" && cat ${ROOT}/packages/sdk/src/a2a-bridge.ts 2>/dev/null | head -40 || echo "NOT FOUND"; echo "=== Vercel Adapter ===" && cat ${ROOT}/packages/ai/src/adapters/vercel.ts 2>/dev/null | head -30 || echo "NOT FOUND"`,
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
    task: `Write E2E tests for the discovery and ecosystem domain.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/discovery-ecosystem.test.ts.
Use node:test + node:assert/strict.

Test the full flow:

1. Discovery flow:
   - Start test server
   - GET /.well-known/agent-configuration returns valid config
   - Config includes correct issuer, jwks_uri, endpoints
   - Config includes supported_scopes

2. OpenAPI-to-scopes flow:
   - Feed a sample OpenAPI spec to generateScopes()
   - Verify generated scopes match expected format
   - Verify scopes work with ScopeChecker

3. Framework adapter flow:
   - Create adapter with test server URL
   - adapter.discover() returns valid AgentConfiguration
   - adapter.registerAgent() creates identity via API
   - adapter.checkScope() validates against granted scopes

4. A2A bridge flow:
   - Convert mock A2A agent card to AgentConfiguration
   - Convert AgentConfiguration back to agent card
   - Verify round-trip preserves name, skills/scopes, URL

5. Integration: agent discovers server, registers, gets scoped token,
   makes authenticated request, server validates scope`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/discovery-ecosystem.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/discovery-ecosystem.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
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
1. All 5 test scenarios pass
2. Discovery + auth + scope check integration works end-to-end
3. A2A bridge round-trip is lossless for critical fields
4. Framework adapter correctly uses the SDK underneath
5. Proper cleanup between tests
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/discovery-ecosystem.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n110 Discovery Ecosystem E2E: ${result.status}`);
}

main().catch(console.error);
