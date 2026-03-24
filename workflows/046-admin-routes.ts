/**
 * 046-admin-routes.ts
 *
 * Domain 5: API Routes
 * /v1/admin/* — system-level operations
 *
 * Depends on: 041
 * Run: agent-relay run workflows/046-admin-routes.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('046-admin-routes')
  .description('/v1/admin/* — system-level operations')
  .pattern('dag')
  .channel('wf-relayauth-046')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design admin routes, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for admin routes',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement admin routes',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review admin routes for security and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-auth-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/middleware/auth.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
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

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-auth-middleware', 'read-env', 'read-worker', 'read-test-helpers'],
    task: `Write tests for the admin routes.

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Worker:
{{steps.read-worker.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/admin-routes.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. GET /v1/admin/health — returns system health (200)
2. POST /v1/admin/rotate-keys — triggers key rotation (200)
3. POST /v1/admin/purge-revocations — cleans expired KV entries (200)
4. GET /v1/admin/stats — returns system statistics (200)
5. Admin routes require INTERNAL_SECRET header (401 without)
6. Regular auth tokens cannot access admin routes (403)
7. Invalid INTERNAL_SECRET returns 401`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/admin-routes.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-auth-middleware', 'read-env', 'read-worker'],
    task: `Implement admin routes to make the tests pass.

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Worker:
{{steps.read-worker.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/routes/admin.ts:
1. Admin auth middleware: check X-Internal-Secret header against env.INTERNAL_SECRET
2. GET /v1/admin/health — system health check
3. POST /v1/admin/rotate-keys — trigger signing key rotation
4. POST /v1/admin/purge-revocations — clean expired KV entries
5. GET /v1/admin/stats — return identity count, token count, etc.
Wire into worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/admin.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/admin-routes.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the admin routes implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. INTERNAL_SECRET comparison uses constant-time comparison
2. Admin routes are fully isolated from regular auth
3. Key rotation logic is safe (grace period)
4. Stats endpoint doesn't leak sensitive data
5. No way to bypass admin auth

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/admin-routes.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n046 Admin Routes: ${result.status}`);
}

main().catch(console.error);
