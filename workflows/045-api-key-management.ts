/**
 * 045-api-key-management.ts
 *
 * Domain 5: API Routes
 * /v1/api-keys — create, list, revoke API keys (for orgs)
 *
 * Depends on: 042
 * Run: agent-relay run workflows/045-api-key-management.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('045-api-key-management')
  .description('/v1/api-keys — create, list, revoke API keys (for orgs)')
  .pattern('dag')
  .channel('wf-relayauth-045')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design API key management, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for API key management',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement API key routes and storage',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review API key management for security and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-org-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/organizations.ts`,
    captureOutput: true,
  })

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

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-org-routes', 'read-auth-middleware', 'read-env', 'read-test-helpers'],
    task: `Write tests for the API key management routes.

Org routes:
{{steps.read-org-routes.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/api-key-management.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test:
1. POST /v1/api-keys — creates key, returns key value once (201)
2. GET /v1/api-keys — lists keys for org (masked, no raw value)
3. POST /v1/api-keys/:id/revoke — revokes key (200)
4. Revoked key cannot authenticate (401)
5. Key is scoped to org (cannot access other orgs)
6. Key has optional expiration
7. Requires admin/manage scope to create keys (403)
8. Key value is hashed in storage, never stored in plain text`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/api-key-management.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-org-routes', 'read-auth-middleware', 'read-env'],
    task: `Implement API key management routes to make the tests pass.

Org routes:
{{steps.read-org-routes.output}}

Auth middleware:
{{steps.read-auth-middleware.output}}

Env:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/routes/api-keys.ts:
1. POST /v1/api-keys — generate key (crypto.randomUUID prefix + random),
   hash with SHA-256 before storing in D1, return raw key once
2. GET /v1/api-keys — list keys (masked: show prefix only)
3. POST /v1/api-keys/:id/revoke — set revoked_at timestamp
Key format: "rk_" + random hex. Store hash, prefix, orgId, scopes, expiresAt.
Wire into worker.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/routes/api-keys.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/api-key-management.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the API key management implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Key is hashed before storage (SHA-256, never stored raw)
2. Key value returned only on creation, never on list/get
3. Revocation is immediate and checked on auth
4. Org scoping is enforced
5. No timing attack vulnerabilities on key comparison
6. Expiration is checked on authentication

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/api-key-management.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n045 API Key Management: ${result.status}`);
}

main().catch(console.error);
