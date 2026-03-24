/**
 * 038-policy-evaluation.ts
 *
 * Domain 4: Scopes & RBAC
 * Evaluate policies: merge scopes + roles + policies → effective permissions
 *
 * Depends on: 037, 036
 * Run: agent-relay run workflows/038-policy-evaluation.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('038-policy-evaluation')
  .description('Evaluate policies: merge scopes + roles + policies → effective permissions')
  .pattern('dag')
  .channel('wf-relayauth-038')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design policy evaluation engine, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for policy evaluation',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement policy evaluation engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review policy evaluation for correctness and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-rbac-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/rbac-spec.md`,
    captureOutput: true,
  })

  .step('read-rbac-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/rbac.ts`,
    captureOutput: true,
  })

  .step('read-policy-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/policies.ts`,
    captureOutput: true,
  })

  .step('read-role-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/roles.ts`,
    captureOutput: true,
  })

  .step('read-role-assignments', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/role-assignments.ts`,
    captureOutput: true,
  })

  .step('read-scope-matcher', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/scope-matcher.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-rbac-spec', 'read-rbac-types', 'read-policy-engine', 'read-role-engine', 'read-scope-matcher', 'read-test-helpers'],
    task: `Write tests for the policy evaluation engine.
    - Budget enforcement in policy evaluation pipeline
    - Budget exceeded → automatic deny + audit event "budget.exceeded"
    - Budget approaching threshold → audit event "budget.alert"


RBAC spec:
{{steps.read-rbac-spec.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Policy engine:
{{steps.read-policy-engine.output}}

Role engine:
{{steps.read-role-engine.output}}

Scope matcher:
{{steps.read-scope-matcher.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/policy-evaluation.test.ts.
    - Budget enforcement in policy evaluation pipeline
    - Budget exceeded → automatic deny + audit event "budget.exceeded"
    - Budget approaching threshold → audit event "budget.alert"

Use node:test + node:assert/strict. Import from test-helpers.js.

Test these behaviors:
1. evaluatePermissions merges identity direct scopes + role scopes
2. Allow policy adds scopes to effective set
3. Deny policy removes scopes from effective set
4. Higher priority policy wins over lower priority
5. Deny policies are evaluated after allow policies at same priority
6. Time-based condition: policy only active within time window
7. Identity-based condition: policy applies only to specific identities
8. Workspace-level policy overrides org-level for that workspace
9. getEffectiveScopes returns final merged scope list
10. checkAccess(identityId, requestedScope) returns allow/deny with reason`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/policy-evaluation.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-rbac-spec', 'read-rbac-types', 'read-policy-engine', 'read-role-assignments', 'read-scope-matcher'],
    task: `Implement the policy evaluation engine to make the tests pass.
    - Budget enforcement in policy evaluation pipeline
    - Budget exceeded → automatic deny + audit event "budget.exceeded"
    - Budget approaching threshold → audit event "budget.alert"


RBAC spec:
{{steps.read-rbac-spec.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Policy engine:
{{steps.read-policy-engine.output}}

Role assignments:
{{steps.read-role-assignments.output}}

Scope matcher:
{{steps.read-scope-matcher.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/engine/policy-evaluation.ts:
    - Budget enforcement in policy evaluation pipeline
    - Budget exceeded → automatic deny + audit event "budget.exceeded"
    - Budget approaching threshold → audit event "budget.alert"

- evaluatePermissions(db, identityId, orgId): Promise<EvaluationResult>
- getEffectiveScopes(db, identityId, orgId): Promise<string[]>
- checkAccess(db, identityId, orgId, requestedScope): Promise<AccessDecision>
- Internal: mergeScopes(directScopes, roleScopes): string[]
- Internal: applyPolicies(scopes, policies, context): string[]
- Internal: evaluateCondition(condition, context): boolean

EvaluationResult: { effectiveScopes, appliedPolicies, deniedScopes }
AccessDecision: { allowed: boolean, reason: string, matchedPolicy?: string }

Algorithm:
1. Collect identity direct scopes
2. Collect scopes from assigned roles
3. Merge all scopes (union)
4. Apply allow policies (add scopes, check conditions)
5. Apply deny policies (remove scopes, check conditions)
6. Higher priority evaluated first, deny wins on tie`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/policy-evaluation.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/policy-evaluation.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the policy evaluation engine implementation.
    - Budget enforcement in policy evaluation pipeline
    - Budget exceeded → automatic deny + audit event "budget.exceeded"
    - Budget approaching threshold → audit event "budget.alert"


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Deny-wins-on-tie semantics are correct
2. Priority ordering is respected
3. Condition evaluation handles all condition types
4. Time conditions use proper timezone handling
5. No privilege escalation possible through policy combination
6. Performance: evaluation doesn't make excessive DB queries

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/policy-evaluation.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n038 Policy Evaluation: ${result.status}`);
}

main().catch(console.error);
