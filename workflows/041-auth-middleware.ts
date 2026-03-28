/**
 * 041-auth-middleware.ts
 *
 * Domain 5: API Routes
 * Request auth: extract token, validate, attach identity to context
 *
 * Depends on: 013, 034
 * Run: agent-relay run workflows/041-auth-middleware.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('041-auth-middleware')
  .description('Request auth: extract token, validate, attach identity to context')
  .pattern('dag')
  .channel('wf-relayauth-041')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design auth middleware, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for auth middleware',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement auth middleware',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review auth middleware for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-scope-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/middleware/scope-middleware.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts && echo "=== IDENTITY ===" && cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-token-verify', 'read-scope-middleware', 'read-env', 'read-types', 'read-test-helpers'],
    task: `Write tests for the auth middleware.

Token verification:
{{steps.read-token-verify.output}}

Scope middleware:
{{steps.read-scope-middleware.output}}

Env bindings:
{{steps.read-env.output}}

Types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/auth-middleware.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. Extracts Bearer token from Authorization header
2. Rejects requests without Authorization header (401)
3. Rejects requests with invalid token (401)
4. Rejects requests with expired token (401)
5. Attaches verified identity to Hono context
6. Allows requests with valid token to proceed
7. Rejects revoked tokens via KV check (401)
8. Passes through public routes without auth`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/auth-middleware.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-verify', 'read-scope-middleware', 'read-env', 'read-types'],
    task: `Implement auth middleware to make the tests pass.

Token verification:
{{steps.read-token-verify.output}}

Scope middleware:
{{steps.read-scope-middleware.output}}

Env:
{{steps.read-env.output}}

Types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/middleware/auth.ts.
The middleware should:
1. Extract Bearer token from Authorization header
2. Verify token using TokenVerifier
3. Check KV revocation list
4. Attach identity claims to Hono context variables
5. Support a public routes allowlist
6. Return 401 JSON errors for auth failures
Export from the middleware index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/middleware/auth.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/auth-middleware.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the auth middleware implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover all auth scenarios (valid, invalid, expired, revoked)
2. Token extraction is robust (Bearer prefix, whitespace)
3. KV revocation check is correct
4. Context attachment uses proper Hono patterns
5. Error responses are consistent JSON format

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/auth-middleware.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n041 Auth Middleware: ${result.status}`);
}

main().catch(console.error);
