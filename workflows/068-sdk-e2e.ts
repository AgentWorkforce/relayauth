/**
 * 068-sdk-e2e.ts
 *
 * Domain 7: SDK & Verification
 * E2E: SDK client -> server -> verify -> scope check (all languages)
 *
 * Depends on: 059, 060, 061, 062, 063, 064, 065, 066, 067
 * Run: agent-relay run workflows/068-sdk-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('068-sdk-e2e')
  .description('SDK & Verification E2E tests')
  .pattern('pipeline')
  .channel('wf-relayauth-068')
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
    role: 'Write E2E test file for SDK & Verification domain',
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
    command: `echo "=== SDK CLIENT ===" && cat ${ROOT}/packages/sdk/src/client.ts && echo "=== VERIFY ===" && cat ${ROOT}/packages/sdk/src/verify.ts && echo "=== HONO MIDDLEWARE ===" && cat ${ROOT}/packages/sdk/src/middleware/hono.ts 2>/dev/null && echo "=== EXPRESS MIDDLEWARE ===" && cat ${ROOT}/packages/sdk/src/middleware/express.ts 2>/dev/null && echo "=== SCOPES ===" && cat ${ROOT}/packages/sdk/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-go-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/go-middleware/relayauth.go 2>/dev/null || echo "Go middleware not available"`,
    captureOutput: true,
  })

  .step('read-python-sdk', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/python-sdk/relayauth/verifier.py 2>/dev/null || echo "Python SDK not available"`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers', 'read-go-middleware', 'read-python-sdk'],
    task: `Write E2E tests for the SDK & Verification domain.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Go middleware:
{{steps.read-go-middleware.output}}

Python SDK:
{{steps.read-python-sdk.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/sdk-verification.test.ts.
Use node:test + node:assert/strict.

Test the full SDK flow:

1. TypeScript SDK E2E:
   a. Create a RelayAuthClient with test server URL
   b. Create an identity via client.createIdentity()
   c. Issue a token via client.issueToken()
   d. Verify the token via TokenVerifier.verify()
   e. Check scopes on the verified claims
   f. Refresh the token via client.refreshToken()
   g. Revoke the token via client.revokeToken()
   h. Verify the revoked token fails

2. Hono Middleware E2E:
   a. Create a test Hono app with relayAuth() middleware
   b. Make request without token → 401
   c. Make request with valid token → 200, identity in context
   d. Make request to scope-protected route without scope → 403
   e. Make request to scope-protected route with scope → 200

3. Express Middleware E2E:
   a. Test relayAuthExpress() with mock req/res
   b. No token → 401
   c. Valid token → req.identity set
   d. Scope check with requireScopeExpress

4. Go Middleware E2E (if available):
   Run: cd ${ROOT}/packages/go-middleware && go test -v -run TestE2E 2>&1
   (This step just verifies Go tests pass, since Go runs separately)

5. Python SDK E2E (if available):
   Run: cd ${ROOT}/packages/python-sdk && python -m pytest tests/ -k e2e 2>&1
   (This step just verifies Python tests pass, since Python runs separately)

6. Cross-language verification:
   a. Issue token via TypeScript client
   b. Verify the same token string would be valid for Go/Python
   (Verify JWT format compatibility by checking base64url encoding)

Use createTestApp() to spin up a test server for the SDK client calls.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/sdk-verification.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/sdk-verification.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('run-go-tests', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT}/packages/go-middleware && go test -v ./... 2>&1 | tail -30; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('run-python-tests', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT}/packages/python-sdk && python -m pytest tests/ -v 2>&1 | tail -30; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e', 'run-go-tests', 'run-python-tests'],
    task: `Review E2E test results across all languages.

TypeScript E2E results:
{{steps.run-e2e.output}}

Go test results:
{{steps.run-go-tests.output}}

Python test results:
{{steps.run-python-tests.output}}

Check:
1. TypeScript SDK E2E: full identity→token→verify→scope→revoke flow passes
2. Hono middleware: auth + scope checking works
3. Express middleware: auth + scope checking works
4. Go middleware: all tests pass
5. Python SDK: all tests pass
6. Cross-language token format is compatible
7. Error cases covered: expired, revoked, insufficient scope
List issues across any language.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures across all languages.

TypeScript results:
{{steps.run-e2e.output}}

Go results:
{{steps.run-go-tests.output}}

Python results:
{{steps.run-python-tests.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues. Then re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/sdk-verification.test.ts

If Go tests failed, also fix and run:
cd ${ROOT}/packages/go-middleware && go test -v ./...

If Python tests failed, also fix and run:
cd ${ROOT}/packages/python-sdk && python -m pytest tests/ -v`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n068 SDK E2E: ${result.status}`);
}

main().catch(console.error);
