/**
 * 061-sdk-client-roles.ts
 *
 * Domain 7: SDK & Verification
 * RelayAuthClient role management methods
 *
 * Depends on: 035, 036
 * Run: agent-relay run workflows/061-sdk-client-roles.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('061-sdk-client-roles')
  .description('RelayAuthClient role management methods')
  .pattern('dag')
  .channel('wf-relayauth-061')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design SDK role methods, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for SDK role management methods',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement SDK role management methods on RelayAuthClient',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review SDK role methods for correctness and API consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-rbac-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/rbac.ts`,
    captureOutput: true,
  })

  .step('read-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/errors.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-client', 'read-rbac-types', 'read-errors'],
    task: `Write tests for RelayAuthClient role management methods.

Existing client:
{{steps.read-client.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Errors:
{{steps.read-errors.output}}

Write failing tests to ${ROOT}/packages/sdk/typescript/src/__tests__/client-roles.test.ts.
Use node:test + node:assert/strict.

Test these methods on RelayAuthClient:
1. createRole(orgId, input) — POST /v1/roles, returns Role
   - input: { name, description, scopes, workspaceId? }
2. getRole(roleId) — GET /v1/roles/:id, returns Role
3. listRoles(orgId) — GET /v1/roles?orgId=X, returns Role[]
4. updateRole(roleId, updates) — PATCH /v1/roles/:id, returns Role
5. deleteRole(roleId) — DELETE /v1/roles/:id, returns void
6. assignRole(identityId, roleId) — POST /v1/identities/:id/roles, body: { roleId }
7. removeRole(identityId, roleId) — DELETE /v1/identities/:id/roles/:roleId

Mock fetch to verify correct URL, method, headers, and body.
Test error cases: role not found (404), duplicate role name (409).`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/client-roles.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-client', 'read-rbac-types', 'read-errors'],
    task: `Add role management methods to RelayAuthClient.

Existing client:
{{steps.read-client.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Errors:
{{steps.read-errors.output}}

Tests to pass:
{{steps.write-tests.output}}

Add these methods to RelayAuthClient in ${ROOT}/packages/sdk/typescript/src/client.ts:
- createRole(orgId: string, input: { name: string; description: string; scopes: string[]; workspaceId?: string }): Promise<Role>
- getRole(roleId: string): Promise<Role>
- listRoles(orgId: string): Promise<Role[]>
- updateRole(roleId: string, updates: Partial<{ name: string; description: string; scopes: string[] }>): Promise<Role>
- deleteRole(roleId: string): Promise<void>
- assignRole(identityId: string, roleId: string): Promise<void>
- removeRole(identityId: string, roleId: string): Promise<void>

Use the existing _request helper. Map 404→RelayAuthError, 409→RelayAuthError.
Export Role type from package index.`,
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
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/client-roles.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the SDK role management methods.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/typescript/src/client.ts and the test file. Check:
1. All 7 role methods implemented correctly
2. assignRole/removeRole use identity endpoint with role sub-resource
3. listRoles passes orgId as query param
4. Error handling consistent with other client methods
5. Role type properly imported from @relayauth/types
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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/client-roles.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n061 SDK Client Roles: ${result.status}`);
}

main().catch(console.error);
