/**
 * 065-sdk-middleware-express.ts
 *
 * Domain 7: SDK & Verification
 * Express middleware: verifyToken() for Node.js servers
 *
 * Depends on: 063
 * Run: agent-relay run workflows/065-sdk-middleware-express.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('065-sdk-middleware-express')
  .description('Express middleware: verifyToken() for Node.js servers')
  .pattern('dag')
  .channel('wf-relayauth-065')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design Express middleware, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for Express verifyToken middleware',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement Express verifyToken middleware',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review Express middleware for security and Express best practices',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-hono-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/middleware/hono.ts 2>/dev/null || echo "NOT YET CREATED"`,
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

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-verify', 'read-hono-middleware', 'read-token-types', 'read-errors'],
    task: `Write tests for Express verifyToken middleware.

TokenVerifier:
{{steps.read-verify.output}}

Hono middleware (for API parity):
{{steps.read-hono-middleware.output}}

Token types:
{{steps.read-token-types.output}}

Errors:
{{steps.read-errors.output}}

Write tests to ${ROOT}/packages/sdk/typescript/src/__tests__/middleware-express.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. relayAuthExpress(options) — creates Express middleware (req, res, next)
   - Extracts Bearer token from req.headers.authorization
   - Calls TokenVerifier.verify() with the token
   - Sets req.identity = claims on success, calls next()
   - Returns res.status(401).json({ error, code }) on missing/invalid token
   - Returns res.status(401).json({ error, code }) on expired token
2. requireScopeExpress(scope) — Express middleware for scope checking
   - Reads req.identity
   - Returns 403 if scope missing
   - Calls next() if scope present
3. Options: { jwksUrl, issuer, audience, onError? }

Mock req/res/next objects for testing (no need for supertest).
Create mock req with headers, mock res with status().json() chain.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/middleware-express.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-verify', 'read-hono-middleware', 'read-token-types', 'read-errors'],
    task: `Implement Express verifyToken middleware.

TokenVerifier:
{{steps.read-verify.output}}

Hono middleware (for API parity reference):
{{steps.read-hono-middleware.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/sdk/typescript/src/middleware/express.ts:

import { TokenVerifier, VerifyOptions } from '../verify.js';
import type { RelayAuthTokenClaims } from '@relayauth/types';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      identity?: RelayAuthTokenClaims;
    }
  }
}

export interface RelayAuthExpressOptions extends VerifyOptions {
  onError?: (error: Error, req: any, res: any) => void;
}

export function relayAuthExpress(options?: RelayAuthExpressOptions): (req: any, res: any, next: any) => Promise<void>
  - Extract Bearer token from req.headers.authorization
  - Create/reuse TokenVerifier with options
  - On success: req.identity = claims, call next()
  - On failure: res.status(401).json({ error: message, code })

export function requireScopeExpress(scope: string): (req: any, res: any, next: any) => void
  - Read claims from req.identity
  - Check scope using ScopeChecker
  - On failure: res.status(403).json({ error, code: 'insufficient_scope' })

Export from ${ROOT}/packages/sdk/typescript/src/index.ts.
Note: Express is NOT a dependency — use generic (req, res, next) typing.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/middleware/express.ts && echo "express.ts OK" || echo "express.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/middleware-express.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the Express verifyToken middleware.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/typescript/src/middleware/express.ts and the test file. Check:
1. Middleware signature is standard Express (req, res, next)
2. Express is NOT added as a dependency (generic types used)
3. Token extraction handles "Bearer " prefix correctly
4. Claims stored on req.identity
5. Error responses match Hono middleware format for consistency
6. requireScopeExpress checks req.identity exists first
7. TokenVerifier instance reused across requests
8. API is consistent with Hono middleware (relayAuth vs relayAuthExpress naming)
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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/middleware-express.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n065 SDK Middleware Express: ${result.status}`);
}

main().catch(console.error);
