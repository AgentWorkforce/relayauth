/**
 * 014-token-issuance-api.ts
 *
 * Domain 2: Token System
 * POST /v1/tokens — issue access + refresh token pair
    - sponsor field is REQUIRED — every token traces to a human
    - parentTokenId: if present, new token scopes MUST be subset of parent (scope narrowing)
    - Attempting scope escalation returns 403 + audit event
    - Default TTL: access=1h, refresh=24h, max=30 days. No permanent tokens.
    - budget field: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }

 *
 * Depends on: 011
 * Run: agent-relay run workflows/014-token-issuance-api.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('014-token-issuance-api')
  .description('POST /v1/tokens — issue access + refresh token pair')
    - sponsor field is REQUIRED — every token traces to a human
    - parentTokenId: if present, new token scopes MUST be subset of parent (scope narrowing)
    - Attempting scope escalation returns 403 + audit event
    - Default TTL: access=1h, refresh=24h, max=30 days. No permanent tokens.
    - budget field: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }

  .pattern('dag')
  .channel('wf-relayauth-014')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token issuance API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for token issuance endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement token issuance route and engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review token issuance for security, correctness, API design',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/token-format-spec.md`,
    captureOutput: true,
  })

  .step('read-openapi', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/openapi.yaml 2>/dev/null || cat ${ROOT}/specs/openapi-spec.md 2>/dev/null || echo "No OpenAPI spec found"`,
    captureOutput: true,
  })

  .step('read-signing-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/jwt-signing.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
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
    dependsOn: ['read-token-spec', 'read-signing-engine', 'read-types', 'read-test-helpers'],
    task: `Write tests for the token issuance API endpoint.

Token spec:
{{steps.read-token-spec.output}}

Signing engine:
{{steps.read-signing-engine.output}}

Token types:
{{steps.read-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/token-issuance.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. POST /v1/tokens with valid body returns 201 with TokenPair
    - sponsor field is REQUIRED — every token traces to a human
    - parentTokenId: if present, new token scopes MUST be subset of parent (scope narrowing)
    - Attempting scope escalation returns 403 + audit event
    - Default TTL: access=1h, refresh=24h, max=30 days. No permanent tokens.
    - budget field: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }

2. Response includes accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, tokenType: "Bearer"
3. Access token is a valid JWT with correct claims (sub, org, wks, scopes)
4. Refresh token is a valid JWT with sid claim
5. Reject request with missing identityId — returns 400
6. Reject request with missing orgId — returns 400
7. Reject request with invalid scopes format — returns 400
8. Access token default TTL is 1 hour
9. Refresh token default TTL is 7 days
10. Custom TTL via expiresIn parameter`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/token-issuance.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-issuance', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-spec', 'read-signing-engine', 'read-types', 'read-worker'],
    task: `Implement the token issuance API.

Token spec:
{{steps.read-token-spec.output}}

Signing engine:
{{steps.read-signing-engine.output}}

Token types:
{{steps.read-types.output}}

Current worker:
{{steps.read-worker.output}}

Tests to pass:
{{steps.write-tests.output}}

1. Create ${ROOT}/packages/server/src/engine/token-issuance.ts:
   - issueTokenPair(params: { identityId, orgId, workspaceId, scopes, audience?, meta?, expiresIn? }, signingKey) → TokenPair
   - Generate unique jti (tok_xxxx format) for each token
   - Generate unique sid for refresh token session
   - Access token: 1h default TTL, contains full claims
   - Refresh token: 7d default TTL, contains sid + sub + org
   - Use signToken from jwt-signing engine

2. Create ${ROOT}/packages/server/src/routes/tokens.ts:
   - POST /v1/tokens handler
    - sponsor field is REQUIRED — every token traces to a human
    - parentTokenId: if present, new token scopes MUST be subset of parent (scope narrowing)
    - Attempting scope escalation returns 403 + audit event
    - Default TTL: access=1h, refresh=24h, max=30 days. No permanent tokens.
    - budget field: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }

   - Validate request body (identityId, orgId required)
   - Call issueTokenPair engine function
   - Return 201 with TokenPair response

3. Register route in worker.ts

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-issuance'],
    command: `test -f ${ROOT}/packages/server/src/engine/token-issuance.ts && echo "engine OK" || echo "engine MISSING"; test -f ${ROOT}/packages/server/src/routes/tokens.ts && echo "route OK" || echo "route MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-issuance.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the token issuance implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Token IDs use tok_ prefix with secure random generation
2. Session IDs use ses_ prefix for refresh tokens
3. Access and refresh tokens have different TTLs
4. Request validation covers all required fields
5. Error responses follow error catalog format
6. Route properly integrated into worker.ts
7. No token leakage in error responses

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/token-issuance.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n014 Token Issuance API: ${result.status}`);
}

main().catch(console.error);
