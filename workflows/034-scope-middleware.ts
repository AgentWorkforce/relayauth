/**
 * 034-scope-middleware.ts
 *
 * Domain 4: Scopes & RBAC
 * Server middleware: extract token, check scopes per-route
 *
 * Depends on: 033, 013
 * Run: agent-relay run workflows/034-scope-middleware.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('034-scope-middleware')
  .description('Server middleware: extract token, check scopes per-route')
  .pattern('dag')
  .channel('wf-relayauth-034')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design scope middleware, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for scope middleware',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement scope middleware',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope middleware for security and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-scope-checker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-token-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-server-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-existing-middleware', {
    type: 'deterministic',
    command: `ls ${ROOT}/packages/server/src/middleware/ 2>/dev/null && cat ${ROOT}/packages/server/src/middleware/*.ts 2>/dev/null || echo "No middleware files yet"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-scope-checker', 'read-token-verify', 'read-server-env', 'read-test-helpers', 'read-existing-middleware'],
    task: `Write tests for the scope middleware.

ScopeChecker:
{{steps.read-scope-checker.output}}

Token verifier:
{{steps.read-token-verify.output}}

Server env:
{{steps.read-server-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/scope-middleware.test.ts.
Use node:test + node:assert/strict. Import from test-helpers.js.

Test these behaviors:
1. requireScope("relaycast:channel:read:*") middleware allows request with matching token
2. requireScope rejects request with 403 when scope not in token
3. requireScope rejects request with 401 when no Authorization header
4. requireScope rejects request with 401 when token is invalid/expired
5. requireScopes(["a", "b"]) requires ALL scopes
6. requireAnyScope(["a", "b"]) requires at least ONE scope
7. Middleware sets c.var.identity with the verified token claims
8. Middleware sets c.var.scopeChecker with a ScopeChecker instance
9. Custom error handler can be provided for scope failures
10. Token extraction from "Bearer {token}" header format`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/scope-middleware.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-scope-checker', 'read-token-verify', 'read-server-env'],
    task: `Implement the scope middleware to make the tests pass.

ScopeChecker:
{{steps.read-scope-checker.output}}

Token verifier:
{{steps.read-token-verify.output}}

Server env:
{{steps.read-server-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/middleware/scope.ts:
- requireScope(scope: string): Hono middleware
- requireScopes(scopes: string[]): Hono middleware — requires ALL
- requireAnyScope(scopes: string[]): Hono middleware — requires ANY
- Extract Bearer token from Authorization header
- Verify token using TokenVerifier
- Build ScopeChecker from token claims
- Set c.var.identity and c.var.scopeChecker
- Return 401 for missing/invalid token, 403 for insufficient scope
- Use consistent JSON error response format`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/middleware/scope.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/scope-middleware.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the scope middleware implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Token extraction is secure (no injection vectors)
2. 401 vs 403 distinction is correct per HTTP spec
3. Error responses have consistent format
4. Middleware composes correctly with Hono's middleware chain
5. No timing attacks on token validation

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/scope-middleware.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n034 Scope Middleware: ${result.status}`);
}

main().catch(console.error);
