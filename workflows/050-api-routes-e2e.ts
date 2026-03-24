/**
 * 050-api-routes-e2e.ts
 *
 * Domain 5: API Routes
 * E2E: full API flow with auth, RBAC, rate limiting
 *
 * Depends on: 041, 042, 043, 044, 045, 046, 047, 048, 049
 * Run: agent-relay run workflows/050-api-routes-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('050-api-routes-e2e')
  .description('E2E: full API flow with auth, RBAC, rate limiting')
  .pattern('pipeline')
  .channel('wf-relayauth-050')
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
    command: `cat ${ROOT}/packages/server/src/middleware/auth.ts && echo "=== ORG ROUTES ===" && cat ${ROOT}/packages/server/src/routes/organizations.ts && echo "=== WORKSPACE ROUTES ===" && cat ${ROOT}/packages/server/src/routes/workspaces.ts && echo "=== API KEYS ===" && cat ${ROOT}/packages/server/src/routes/api-keys.ts && echo "=== RATE LIMIT ===" && cat ${ROOT}/packages/server/src/middleware/rate-limit.ts && echo "=== ERROR HANDLER ===" && cat ${ROOT}/packages/server/src/middleware/error-handler.ts && echo "=== CORS ===" && cat ${ROOT}/packages/server/src/middleware/cors-headers.ts`,
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
    task: `Write E2E tests for Domain 5: API Routes.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/api-routes.test.ts.
Use node:test + node:assert/strict. Import helpers from ../test-helpers.js.

Test the full flow:
1. Auth flow: request without token → 401, with valid token → 200
2. Org lifecycle: create org → read → update → list
3. Workspace lifecycle: create workspace → add member → list members → remove member
4. API key lifecycle: create key → use key to auth → revoke → verify revoked
5. Admin routes: health check with internal secret, reject without
6. Rate limiting: send requests until 429, verify headers
7. Error handling: trigger validation error → verify format, trigger 404
8. CORS: preflight OPTIONS → verify headers, verify request ID
9. Full integration: create org → create workspace → add identity →
   issue API key → use key → rate limit → verify all headers`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/api-routes.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/api-routes.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results for API Routes.

Results:
{{steps.run-e2e.output}}

Check:
1. All 9 scenarios pass
2. Full integration flow works end-to-end
3. Auth, RBAC, rate limiting, error handling all work together
4. Proper cleanup between tests
5. No flaky timing-dependent tests
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/api-routes.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n050 API Routes E2E: ${result.status}`);
}

main().catch(console.error);
