/**
 * 059-sdk-client-identities.ts
 *
 * Domain 7: SDK & Verification
 * RelayAuthClient identity CRUD methods
 *
 * Depends on: 022, 023, 024, 025, 026, 027, 028, 029
 * Run: agent-relay run workflows/059-sdk-client-identities.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('059-sdk-client-identities')
  .description('RelayAuthClient identity CRUD methods')
  .pattern('dag')
  .channel('wf-relayauth-059')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design SDK identity methods, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for SDK identity CRUD methods',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement SDK identity CRUD methods on RelayAuthClient',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review SDK identity methods for completeness and consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/errors.ts`,
    captureOutput: true,
  })

  .step('read-server-identity-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/identities.ts 2>/dev/null || echo "NOT YET CREATED"`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/__tests__/verify.test.ts 2>/dev/null; echo "---"; ls ${ROOT}/packages/sdk/typescript/src/__tests__/ 2>/dev/null || echo "no tests yet"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-client', 'read-types', 'read-errors'],
    task: `Write tests for RelayAuthClient identity CRUD methods.

Existing client:
{{steps.read-client.output}}

Identity types:
{{steps.read-types.output}}

Errors:
{{steps.read-errors.output}}

Write failing tests to ${ROOT}/packages/sdk/typescript/src/__tests__/client-identities.test.ts.
Use node:test + node:assert/strict.

Test these methods on RelayAuthClient:
1. createIdentity(orgId, input) — POST /v1/identities, returns AgentIdentity
2. getIdentity(identityId) — GET /v1/identities/:id
3. listIdentities(orgId, options?) — GET /v1/identities with query params (limit, cursor, status filter)
4. updateIdentity(identityId, updates) — PATCH /v1/identities/:id
5. suspendIdentity(identityId, reason) — POST /v1/identities/:id/suspend
6. reactivateIdentity(identityId) — POST /v1/identities/:id/reactivate
7. retireIdentity(identityId) — POST /v1/identities/:id/retire
8. deleteIdentity(identityId) — DELETE /v1/identities/:id

Mock fetch to verify correct URL, method, headers (Authorization: Bearer), and body.
Verify error handling: 404 → IdentityNotFoundError, 403 → IdentitySuspendedError.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/client-identities.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-client', 'read-types', 'read-errors'],
    task: `Add identity CRUD methods to RelayAuthClient.

Existing client:
{{steps.read-client.output}}

Types:
{{steps.read-types.output}}

Errors:
{{steps.read-errors.output}}

Tests to pass:
{{steps.write-tests.output}}

Add these methods to the RelayAuthClient class in ${ROOT}/packages/sdk/typescript/src/client.ts:
- createIdentity(orgId: string, input: CreateIdentityInput): Promise<AgentIdentity>
- getIdentity(identityId: string): Promise<AgentIdentity>
- listIdentities(orgId: string, options?: { limit?: number; cursor?: string; status?: IdentityStatus }): Promise<{ identities: AgentIdentity[]; cursor?: string }>
- updateIdentity(identityId: string, updates: Partial<CreateIdentityInput>): Promise<AgentIdentity>
- suspendIdentity(identityId: string, reason: string): Promise<AgentIdentity>
- reactivateIdentity(identityId: string): Promise<AgentIdentity>
- retireIdentity(identityId: string): Promise<AgentIdentity>
- deleteIdentity(identityId: string): Promise<void>

Add a private _request helper for HTTP calls with auth headers.
Handle errors by status code, throwing typed errors from errors.ts.
Export from the package index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/client.ts && echo "client.ts OK" || echo "client.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/client-identities.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the SDK identity CRUD methods.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/typescript/src/client.ts and the test file. Check:
1. All 8 identity methods implemented correctly
2. Proper HTTP method/path for each endpoint
3. Authorization header included in all requests
4. Error mapping (404→IdentityNotFoundError, 403→IdentitySuspendedError)
5. Query params correctly serialized for listIdentities
6. Types match @relayauth/types definitions
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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/client-identities.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n059 SDK Client Identities: ${result.status}`);
}

main().catch(console.error);
