/**
 * 064-sdk-middleware-hono.ts
 *
 * Domain 7: SDK & Verification
 * Hono middleware: verifyToken() for protecting routes
 *
 * Depends on: 063
 * Run: agent-relay run workflows/064-sdk-middleware-hono.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('064-sdk-middleware-hono')
  .description('Hono middleware: verifyToken() for protecting routes')
  .pattern('dag')
  .channel('wf-relayauth-064')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design Hono middleware, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for Hono verifyToken middleware',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement Hono verifyToken middleware',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review Hono middleware for security and Hono best practices',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/errors.ts`,
    captureOutput: true,
  })

  .step('read-scopes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-sdk-index', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/index.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-verify', 'read-token-types', 'read-errors', 'read-scopes'],
    task: `Write tests for Hono verifyToken middleware.

TokenVerifier:
{{steps.read-verify.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Write tests to ${ROOT}/packages/sdk/typescript/src/__tests__/middleware-hono.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. relayAuth() middleware — creates Hono middleware that verifies tokens
   - Extracts Bearer token from Authorization header
   - Calls TokenVerifier.verify() with the token
   - Sets c.set('identity', claims) on success
   - Returns 401 JSON error on missing/invalid token
   - Returns 401 JSON error on expired token
2. requireScope(scope) middleware — checks scope after auth
   - Returns 403 if token lacks required scope
   - Calls next() if scope is present
3. Composing: app.use('/api/*', relayAuth(options)); app.use('/api/admin/*', requireScope('relayauth:admin:*'))
4. Options: { jwksUrl, issuer, audience, onError? }

Create a test Hono app with the middleware and make requests against it.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/middleware-hono.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-verify', 'read-token-types', 'read-errors', 'read-scopes'],
    task: `Implement Hono verifyToken middleware.

TokenVerifier:
{{steps.read-verify.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/sdk/typescript/src/middleware/hono.ts:

import { MiddlewareHandler } from 'hono';
import { TokenVerifier, VerifyOptions } from '../verify.js';
import type { RelayAuthTokenClaims } from '@relayauth/types';

export interface RelayAuthMiddlewareOptions extends VerifyOptions {
  onError?: (error: Error) => Response | void;
}

export function relayAuth(options?: RelayAuthMiddlewareOptions): MiddlewareHandler
  - Extract Bearer token from Authorization header
  - Create/reuse TokenVerifier with options
  - On success: c.set('identity', claims), call next()
  - On failure: return c.json({ error, code }, 401)

export function requireScope(scope: string): MiddlewareHandler
  - Read claims from c.get('identity')
  - Check scope using ScopeChecker
  - On failure: return c.json({ error, code: 'insufficient_scope' }, 403)

Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/middleware/hono.ts && echo "hono.ts OK" || echo "hono.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/middleware-hono.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the Hono verifyToken middleware.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/typescript/src/middleware/hono.ts and the test file. Check:
1. Middleware signature matches Hono's MiddlewareHandler type
2. Token extraction handles "Bearer " prefix correctly
3. Claims stored on context via c.set() with proper typing
4. Error responses are JSON with consistent format
5. requireScope properly reads claims from context
6. TokenVerifier instance is reused (not created per-request)
7. Exported from package index
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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/middleware-hono.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n064 SDK Middleware Hono: ${result.status}`);
}

main().catch(console.error);
