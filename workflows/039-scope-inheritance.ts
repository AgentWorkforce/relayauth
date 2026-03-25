/**
 * 039-scope-inheritance.ts
 *
 * Domain 4: Scopes & RBAC
 * Org → workspace → agent scope inheritance chain
 *
 * Depends on: 038
 * Run: agent-relay run workflows/039-scope-inheritance.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('039-scope-inheritance')
  .description('Org → workspace → agent scope inheritance chain')
  .pattern('dag')
  .channel('wf-relayauth-039')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design scope inheritance, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for scope inheritance',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement scope inheritance engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope inheritance for correctness and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-rbac-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/rbac.md`,
    captureOutput: true,
  })

  .step('read-policy-evaluation', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/policy-evaluation.ts`,
    captureOutput: true,
  })

  .step('read-scope-matcher', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/scope-matcher.ts`,
    captureOutput: true,
  })

  .step('read-identity-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-rbac-spec', 'read-policy-evaluation', 'read-scope-matcher', 'read-identity-types', 'read-test-helpers'],
    task: `Write tests for the scope inheritance engine.

RBAC spec:
{{steps.read-rbac-spec.output}}

Policy evaluation:
{{steps.read-policy-evaluation.output}}

Scope matcher:
{{steps.read-scope-matcher.output}}

Identity types:
{{steps.read-identity-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/scope-inheritance.test.ts.
Use node:test + node:assert/strict. Import from test-helpers.js.

Test these behaviors:
1. Org-level scopes are inherited by all workspaces in that org
2. Workspace-level scopes are inherited by all agents in that workspace
3. Agent direct scopes are combined with inherited scopes
4. Workspace scopes cannot exceed org-level scopes (intersection, not union)
5. Agent scopes cannot exceed workspace-level scopes
6. Org deny policy blocks scope even if workspace allows it
7. Workspace deny policy blocks scope even if agent has it directly
8. resolveInheritedScopes(db, identityId) returns full inheritance chain
9. Inheritance chain: org roles → workspace roles → agent roles → direct scopes
10. getInheritanceChain(db, identityId) returns { org, workspace, agent } scope breakdown`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/scope-inheritance.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-rbac-spec', 'read-policy-evaluation', 'read-scope-matcher'],
    task: `Implement the scope inheritance engine to make the tests pass.

RBAC spec:
{{steps.read-rbac-spec.output}}

Policy evaluation:
{{steps.read-policy-evaluation.output}}

Scope matcher:
{{steps.read-scope-matcher.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/engine/scope-inheritance.ts:
- resolveInheritedScopes(db, identityId): Promise<string[]>
- getInheritanceChain(db, identityId): Promise<InheritanceChain>
- Internal: getOrgScopes(db, orgId): Promise<string[]>
- Internal: getWorkspaceScopes(db, workspaceId): Promise<string[]>
- Internal: getAgentScopes(db, identityId): Promise<string[]>
- Internal: intersectScopes(parent, child): string[]

InheritanceChain: {
  org: { scopes: string[], roles: Role[], policies: Policy[] },
  workspace: { scopes: string[], roles: Role[], policies: Policy[] },
  agent: { scopes: string[], roles: Role[] },
  effective: string[]
}

Algorithm:
1. Get org-level allowed scopes (roles + policies)
2. Get workspace-level scopes, intersected with org scopes
3. Get agent-level scopes, intersected with workspace scopes
4. Apply deny policies at each level
5. Return effective scopes

Export from engine index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/scope-inheritance.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/scope-inheritance.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the scope inheritance implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Inheritance uses intersection (not union) at each level
2. No privilege escalation: child can never exceed parent scopes
3. Deny policies at higher levels cannot be overridden
4. DB queries are efficient (batch where possible)
5. Edge cases: agent with no workspace, workspace with no org roles

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/scope-inheritance.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n039 Scope Inheritance: ${result.status}`);
}

main().catch(console.error);
