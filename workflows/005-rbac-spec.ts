/**
 * 005-rbac-spec.ts
 *
 * Domain 1: Foundation
 * Define role/policy format, inheritance, evaluation order
 *
 * Depends on: 004
 * Run: agent-relay run workflows/005-rbac-spec.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('005-rbac-spec')
  .description('Define role/policy format, inheritance, evaluation order')
  .pattern('dag')
  .channel('wf-relayauth-005')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design RBAC spec, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the RBAC spec document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review RBAC spec for security and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/rbac.ts`,
    captureOutput: true,
  })

  .step('read-scope-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/scope-format.md`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-types', 'read-scope-spec'],
    task: `Design the RBAC specification.

Architecture:
{{steps.read-architecture.output}}

RBAC types:
{{steps.read-types.output}}

Scope format spec:
{{steps.read-scope-spec.output}}

Write design outline to ${ROOT}/docs/rbac-design.md covering:
- Role format: name, scopes, org/workspace binding
- Policy format: effect (allow/deny), conditions, priority
- Evaluation order: deny-first, priority-ordered
- Inheritance: org → workspace → agent
- Built-in roles (admin, developer, read-only)
- Effective permissions calculation algorithm`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full RBAC spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

RBAC types:
{{steps.read-types.output}}

Write to ${ROOT}/specs/rbac.md. Include:
- Role definition: fields, constraints, built-in roles
- Policy definition: effect, scopes, conditions, priority
- Policy conditions: time-based, IP-based, identity-based
- Evaluation algorithm (pseudocode)
- Inheritance chain: org roles → workspace roles → direct scopes
- Conflict resolution: explicit deny wins, then highest priority
- Examples: common role setups, policy deny patterns`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/rbac.md && wc -l ${ROOT}/specs/rbac.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the RBAC spec.

Read ${ROOT}/specs/rbac.md and check:
1. Role and policy formats match types package
2. Evaluation algorithm is deterministic and unambiguous
3. Inheritance chain is clearly defined
4. Deny policies properly override allow
5. Condition types cover the documented use cases
6. No privilege escalation paths
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the RBAC spec.

Reviewer feedback:
{{steps.review-spec.output}}

Address all feedback. Update ${ROOT}/specs/rbac.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n005 RBAC Spec: ${result.status}`);
}

main().catch(console.error);
