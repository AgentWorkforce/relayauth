/**
 * 040-rbac-e2e.ts
 *
 * Domain 4: Scopes & RBAC
 * E2E: create role → assign → verify access → policy deny → verify denied
    Test scenarios:
 *
 * Depends on: 031, 032, 033, 034, 035, 036, 037, 038, 039
 * Run: agent-relay run workflows/040-rbac-e2e.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('040-rbac-e2e')
  .description('Scopes & RBAC E2E tests')
    Test scenarios:
  .pattern('pipeline')
  .channel('wf-relayauth-040')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E test scenarios, fix failures',
    Test scenarios:
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E test file',
    Test scenarios:
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    Test scenarios:
    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `echo "=== SCOPE PARSER ===" && cat ${ROOT}/packages/sdk/src/scope-parser.ts && echo "=== SCOPE MATCHER ===" && cat ${ROOT}/packages/sdk/src/scope-matcher.ts && echo "=== SCOPE CHECKER ===" && cat ${ROOT}/packages/sdk/src/scopes.ts && echo "=== SCOPE MIDDLEWARE ===" && cat ${ROOT}/packages/server/src/middleware/scope.ts && echo "=== ROLE ENGINE ===" && cat ${ROOT}/packages/server/src/engine/roles.ts && echo "=== ROLE ASSIGNMENTS ===" && cat ${ROOT}/packages/server/src/engine/role-assignments.ts && echo "=== POLICY ENGINE ===" && cat ${ROOT}/packages/server/src/engine/policies.ts && echo "=== POLICY EVALUATION ===" && cat ${ROOT}/packages/server/src/engine/policy-evaluation.ts && echo "=== SCOPE INHERITANCE ===" && cat ${ROOT}/packages/server/src/engine/scope-inheritance.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers'],
    task: `Write E2E tests for the Scopes & RBAC domain.
    Test scenarios:
    - Sub-agent scope narrowing: parent has A+B, child requests A+B+C → only gets A+B
    - Budget exceeded → action denied with clear error
    - Scope escalation attempt → 403 + audit event logged


Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/rbac.test.ts.
Use node:test + node:assert/strict. Import from ../test-helpers.js.

Test the full RBAC flow:

1. Parse and validate scope strings (valid + invalid)
2. Create a role with scopes ["relaycast:channel:read:*", "relaycast:channel:write:*"]
3. Create an identity and assign the role
4. Verify: token with role scopes can access relaycast:channel:read:general
5. Verify: token with role scopes CANNOT access relayfile:fs:write:*
6. Create a deny policy: deny relaycast:channel:write:* for the identity
7. Verify: identity can still read but CANNOT write after deny policy
8. Test scope inheritance: org grants relaycast:*:*:*, workspace restricts to relaycast:channel:*:*, agent further restricted
9. Test policy priority: higher-priority allow overrides lower-priority deny
10. Test scope middleware: protected route returns 403 for insufficient scope
11. Clean up: delete policy, remove role, verify access restored`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/rbac.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/rbac.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results for Scopes & RBAC.
    Test scenarios:
    - Sub-agent scope narrowing: parent has A+B, child requests A+B+C → only gets A+B
    - Budget exceeded → action denied with clear error
    - Scope escalation attempt → 403 + audit event logged


Results:
{{steps.run-e2e.output}}

Check:
1. All RBAC scenarios pass
2. Scope parsing edge cases covered
3. Role assignment → access grant flow works
4. Policy deny → access revocation flow works
5. Scope inheritance chain (org → workspace → agent) enforced
6. Middleware integration tested
7. Proper cleanup between tests
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures for Scopes & RBAC.
    Test scenarios:
    - Sub-agent scope narrowing: parent has A+B, child requests A+B+C → only gets A+B
    - Budget exceeded → action denied with clear error
    - Scope escalation attempt → 403 + audit event logged


Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/rbac.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n040 RBAC E2E: ${result.status}`);
    Test scenarios:
}

main().catch(console.error);
