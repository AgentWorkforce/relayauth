/**
 * 047-rate-limiting.ts
 *
 * Domain 5: API Routes
 * Per-identity and per-org rate limiting
 *
 * Depends on: 041
 * Run: agent-relay run workflows/047-rate-limiting.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('047-rate-limiting')
  .description('Per-identity and per-org rate limiting')
  .pattern('dag')
  .channel('wf-relayauth-047')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design rate limiting middleware, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for rate limiting',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement rate limiting middleware',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review rate limiting for correctness and edge cases',
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
    task: `Write tests for the rate limiting middleware.

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Worker:
{{steps.read-worker.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/rate-limiting.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. Allows requests under the rate limit
2. Returns 429 when per-identity limit exceeded
3. Returns 429 when per-org limit exceeded
4. Includes Retry-After header on 429
5. Includes X-RateLimit-Limit and X-RateLimit-Remaining headers
6. Rate limit resets after window expires
7. Different identities have independent limits
8. Unauthenticated requests use IP-based limiting`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/rate-limiting.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-auth-middleware', 'read-env', 'read-worker'],
    task: `Implement rate limiting middleware to make the tests pass.

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Worker:
{{steps.read-worker.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/middleware/rate-limit.ts:
1. Sliding window rate limiter using KV or in-memory Map
2. Per-identity limit (keyed by token sub claim)
3. Per-org limit (keyed by token org claim)
4. IP-based fallback for unauthenticated requests
5. Configurable limits: default 100 req/min per identity, 1000/min per org
6. Set standard rate limit headers on all responses
7. Return 429 with Retry-After when exceeded
Wire into worker.ts as middleware.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/middleware/rate-limit.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/rate-limiting.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the rate limiting implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Sliding window algorithm is correct
2. No race conditions in counter increment
3. Headers follow standard rate limit conventions
4. Memory cleanup prevents unbounded growth
5. Works correctly in Cloudflare Workers environment
6. IP extraction handles CF-Connecting-IP header

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/rate-limiting.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n047 Rate Limiting: ${result.status}`);
}

main().catch(console.error);
