/**
 * 049-cors-and-headers.ts
 *
 * Domain 5: API Routes
 * CORS config, security headers, request ID
 *
 * Depends on: 041
 * Run: agent-relay run workflows/049-cors-and-headers.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('049-cors-and-headers')
  .description('CORS config, security headers, request ID')
  .pattern('dag')
  .channel('wf-relayauth-049')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design CORS and security headers, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CORS and headers',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CORS and security headers middleware',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CORS and headers for security best practices',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-auth-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/middleware/auth.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-worker', 'read-env', 'read-auth-middleware', 'read-test-helpers'],
    task: `Write tests for CORS and security headers middleware.

Worker:
{{steps.read-worker.output}}

Env:
{{steps.read-env.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/cors-and-headers.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. OPTIONS preflight returns correct CORS headers
2. Access-Control-Allow-Origin matches configured origins
3. Access-Control-Allow-Methods includes GET, POST, PATCH, DELETE
4. Access-Control-Allow-Headers includes Authorization, Content-Type
5. Every response includes X-Request-Id header (UUID)
6. Security headers: X-Content-Type-Options: nosniff
7. Security headers: X-Frame-Options: DENY
8. Request ID is available in Hono context for logging`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/cors-and-headers.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-worker', 'read-env', 'read-auth-middleware'],
    task: `Implement CORS and security headers middleware to make the tests pass.

Worker:
{{steps.read-worker.output}}

Env:
{{steps.read-env.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/middleware/cors-headers.ts:
1. CORS middleware using Hono's cors() or custom implementation
2. Configurable allowed origins (default: relayauth.dev, localhost)
3. Allow methods: GET, POST, PATCH, DELETE, OPTIONS
4. Allow headers: Authorization, Content-Type, X-Request-Id
5. Request ID middleware: generate crypto.randomUUID(), set on context
6. Security headers: X-Content-Type-Options, X-Frame-Options,
   Strict-Transport-Security, X-XSS-Protection
Wire into worker.ts as early middleware (before auth).`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/middleware/cors-headers.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/cors-and-headers.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CORS and security headers implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. CORS doesn't allow wildcard origin in production
2. Credentials mode is handled correctly
3. Security headers follow OWASP recommendations
4. Request ID is a proper UUID v4
5. Middleware order is correct (CORS before auth)
6. Preflight cache is configured (Access-Control-Max-Age)

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/cors-and-headers.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n049 CORS and Headers: ${result.status}`);
}

main().catch(console.error);
