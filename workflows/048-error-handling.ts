/**
 * 048-error-handling.ts
 *
 * Domain 5: API Routes
 * Global error handler, consistent error response format
 *
 * Depends on: 007
 * Run: agent-relay run workflows/048-error-handling.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('048-error-handling')
  .description('Global error handler, consistent error response format')
  .pattern('dag')
  .channel('wf-relayauth-048')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design error handling, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for error handling',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement global error handler',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review error handling for completeness and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-error-catalog', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/error-catalog.md`,
    captureOutput: true,
  })

  .step('read-sdk-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/errors.ts`,
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
    dependsOn: ['read-error-catalog', 'read-sdk-errors', 'read-worker', 'read-test-helpers'],
    task: `Write tests for the global error handler.

Error catalog:
{{steps.read-error-catalog.output}}

SDK errors:
{{steps.read-sdk-errors.output}}

Worker:
{{steps.read-worker.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/error-handling.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. RelayAuthError maps to correct HTTP status and error code
2. Validation errors return 400 with field-level details
3. Unknown errors return 500 with generic message (no stack leak)
4. Error response format: { error: { code, message, details? } }
5. 404 for unknown routes
6. Hono HTTPException is handled correctly
7. Error includes requestId from context
8. Content-Type is always application/json for errors`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/error-handling.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-error-catalog', 'read-sdk-errors', 'read-worker'],
    task: `Implement global error handler to make the tests pass.

Error catalog:
{{steps.read-error-catalog.output}}

SDK errors:
{{steps.read-sdk-errors.output}}

Worker:
{{steps.read-worker.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/middleware/error-handler.ts:
1. Hono onError handler that catches all thrown errors
2. Map RelayAuthError subclasses to HTTP status codes
3. Map Hono HTTPException to standard format
4. Catch unknown errors, return 500 with safe message
5. Always return { error: { code, message, requestId, details? } }
6. Never leak stack traces or internal details in production
7. Log full error details server-side
Wire into worker.ts as app.onError().`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/middleware/error-handler.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/error-handling.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the error handling implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. No stack traces leaked to clients
2. All error catalog codes are handled
3. Error format is consistent across all error types
4. RequestId is included in every error response
5. Unknown errors are safely wrapped
6. Consistent with SDK error classes

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/error-handling.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n048 Error Handling: ${result.status}`);
}

main().catch(console.error);
