/**
 * 004-scope-format-spec.ts
 *
 * Domain 1: Foundation
 * Define scope syntax, wildcard matching, path patterns
 *
 * Depends on: 001
 * Run: agent-relay run workflows/004-scope-format-spec.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('004-scope-format-spec')
  .description('Define scope syntax, wildcard matching, path patterns')
  .pattern('dag')
  .channel('wf-relayauth-004')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design scope format spec, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the scope format spec document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope spec for completeness and edge cases',
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
    command: `cat ${ROOT}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-types'],
    task: `Design the scope format specification.

Architecture:
{{steps.read-architecture.output}}

Scope types:
{{steps.read-types.output}}

Write design outline to ${ROOT}/docs/scope-format-design.md covering:
- Scope string format: {plane}:{resource}:{action}:{path?}
- Wildcard rules: * matches any single segment, ** not supported
- Path patterns for relayfile scopes
- Matching algorithm: requested scope vs granted scopes
- Scope templates (built-in presets)
- Scope validation rules (syntax, allowed planes/actions)`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full scope format spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

Scope types:
{{steps.read-types.output}}

Write to ${ROOT}/specs/scope-format.md. Include:
- Scope string syntax (BNF-style grammar)
- Each segment: plane, resource, action, path
- Wildcard matching rules with examples
- Path pattern matching for filesystem scopes
- Scope comparison: isSubsetOf, isSuperset, overlaps
- Built-in scope templates
- Validation: what makes a scope invalid
- Edge cases: empty scopes, duplicate scopes, conflicting scopes`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/scope-format.md && wc -l ${ROOT}/specs/scope-format.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the scope format spec.

Read ${ROOT}/specs/scope-format.md and check:
1. Syntax is unambiguous and parseable
2. Wildcard matching is well-defined for all cases
3. Path patterns handle relayfile filesystem paths correctly
4. All planes from types are covered
5. Edge cases are documented (empty, duplicate, conflict)
6. Scope templates match the types package
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the scope format spec.

Reviewer feedback:
{{steps.review-spec.output}}

Read each issue from the reviewer feedback above. For each one:
1. Open the file mentioned
2. Make the specific fix described
3. Save the file

After all fixes, verify by reading the file again to confirm changes were applied.

Update ${ROOT}/specs/scope-format.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n004 Scope Format Spec: ${result.status}`);
}

main().catch(console.error);
