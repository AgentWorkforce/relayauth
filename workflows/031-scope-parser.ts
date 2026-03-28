/**
 * 031-scope-parser.ts
 *
 * Domain 4: Scopes & RBAC
 * Parse scope strings, validate format, wildcard matching
 *
 * Depends on: 004
 * Run: agent-relay run workflows/031-scope-parser.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('031-scope-parser')
  .description('Parse scope strings, validate format, wildcard matching')
  .pattern('dag')
  .channel('wf-relayauth-031')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design scope parser, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for scope parser',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement scope parser',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope parser for correctness, edge cases, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-scope-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/scope-format.md`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('read-sdk-scopes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/__tests__/verify.test.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-scope-spec', 'read-scope-types', 'read-sdk-scopes', 'read-test-helpers'],
    task: `Write tests for the scope parser module.
    - Parse scopes with path constraints: "relayfile:fs:read:/docs/*"
    - Parse delegation constraints in scope format
    - isSubsetOf(parentScopes, childScopes): verify child is narrower than parent


Scope format spec:
{{steps.read-scope-spec.output}}

Scope types:
{{steps.read-scope-types.output}}

Existing SDK scopes file:
{{steps.read-sdk-scopes.output}}

Write failing tests to ${ROOT}/packages/sdk/typescript/src/__tests__/scope-parser.test.ts.
    - Parse scopes with path constraints: "relayfile:fs:read:/docs/*"
    - Parse delegation constraints in scope format
    - isSubsetOf(parentScopes, childScopes): verify child is narrower than parent

Use node:test + node:assert/strict.

Test these behaviors:
1. parseScope("relaycast:channel:read:*") returns correct ParsedScope
2. parseScope("relayfile:fs:write:/src/*") parses path correctly
3. parseScope("cloud:workflow:run") handles missing path (defaults to "*")
4. parseScope("invalid") throws InvalidScopeError
5. parseScope("") throws InvalidScopeError
6. parseScope with unknown plane throws InvalidScopeError
7. validateScope returns true for valid scopes
8. validateScope returns false for malformed scopes
9. parseScopes (plural) parses array of scope strings
10. parseScopes filters out invalid scopes with { strict: false }`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/scope-parser.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-scope-spec', 'read-scope-types'],
    task: `Implement the scope parser to make the tests pass.
    - Parse scopes with path constraints: "relayfile:fs:read:/docs/*"
    - Parse delegation constraints in scope format
    - isSubsetOf(parentScopes, childScopes): verify child is narrower than parent


Scope format spec:
{{steps.read-scope-spec.output}}

Scope types:
{{steps.read-scope-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/sdk/typescript/src/scope-parser.ts:
    - Parse scopes with path constraints: "relayfile:fs:read:/docs/*"
    - Parse delegation constraints in scope format
    - isSubsetOf(parentScopes, childScopes): verify child is narrower than parent

- parseScope(raw: string): ParsedScope — parse a single scope string
- validateScope(raw: string): boolean — check if scope string is valid
- parseScopes(raws: string[], opts?: { strict?: boolean }): ParsedScope[]
- Throw InvalidScopeError (from errors.ts) on invalid input
- Scope format: {plane}:{resource}:{action}:{path?}
- Path defaults to "*" if omitted
- Validate plane against known Plane type values

Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/scope-parser.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/scope-parser.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the scope parser implementation.
    - Parse scopes with path constraints: "relayfile:fs:read:/docs/*"
    - Parse delegation constraints in scope format
    - isSubsetOf(parentScopes, childScopes): verify child is narrower than parent


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. All scope format edge cases handled (empty parts, extra colons, etc.)
2. Wildcard matching logic is correct
3. ParsedScope type matches types package definition
4. Errors thrown with correct codes
5. Consistent with @relayauth/types scope definitions

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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/scope-parser.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n031 Scope Parser: ${result.status}`);
}

main().catch(console.error);
