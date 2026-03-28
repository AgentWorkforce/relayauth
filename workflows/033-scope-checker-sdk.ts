/**
 * 033-scope-checker-sdk.ts
 *
 * Domain 4: Scopes & RBAC
 * ScopeChecker class in SDK — high-level scope validation
 *
 * Depends on: 032
 * Run: agent-relay run workflows/033-scope-checker-sdk.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('033-scope-checker-sdk')
  .description('ScopeChecker class in SDK — high-level scope validation')
  .pattern('dag')
  .channel('wf-relayauth-033')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design ScopeChecker API, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for ScopeChecker',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement ScopeChecker class',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review ScopeChecker for API design and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-scope-parser', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scope-parser.ts`,
    captureOutput: true,
  })

  .step('read-scope-matcher', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scope-matcher.ts`,
    captureOutput: true,
  })

  .step('read-existing-scopes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/errors.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-scope-parser', 'read-scope-matcher', 'read-existing-scopes', 'read-errors'],
    task: `Write tests for the ScopeChecker class.

Scope parser:
{{steps.read-scope-parser.output}}

Scope matcher:
{{steps.read-scope-matcher.output}}

Existing scopes scaffold:
{{steps.read-existing-scopes.output}}

Errors:
{{steps.read-errors.output}}

Write failing tests to ${ROOT}/packages/sdk/typescript/src/__tests__/scope-checker.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. new ScopeChecker(["relaycast:*:*:*"]) — constructor accepts granted scopes
2. checker.check("relaycast:channel:read:general") returns true
3. checker.check("relayfile:fs:write:/src") returns false (not granted)
4. checker.require("relaycast:channel:read:*") does not throw
5. checker.require("relayfile:fs:write:*") throws InsufficientScopeError
6. checker.checkAll(["relaycast:channel:read:*", "relaycast:channel:write:*"]) → true when all granted
7. checker.checkAll([...]) → false when any not granted
8. checker.checkAny([...]) → true when at least one granted
9. checker.effectiveScopes() returns parsed list of granted scopes
10. ScopeChecker.fromToken(claims) builds checker from token claims`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/scope-checker.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-scope-parser', 'read-scope-matcher', 'read-errors'],
    task: `Implement the ScopeChecker class to make the tests pass.

Scope parser:
{{steps.read-scope-parser.output}}

Scope matcher:
{{steps.read-scope-matcher.output}}

Errors:
{{steps.read-errors.output}}

Tests to pass:
{{steps.write-tests.output}}

Update ${ROOT}/packages/sdk/typescript/src/scopes.ts with the full ScopeChecker class:
- constructor(grantedScopes: string[])
- check(scope: string): boolean — returns true if scope is granted
- require(scope: string): void — throws InsufficientScopeError if not granted
- checkAll(scopes: string[]): boolean — all must match
- checkAny(scopes: string[]): boolean — at least one must match
- effectiveScopes(): ParsedScope[] — returns parsed granted scopes
- static fromToken(claims: { scopes: string[] }): ScopeChecker

Uses matchScope/matchesAny from scope-matcher.ts.
Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/scopes.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/scope-checker.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the ScopeChecker implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. ScopeChecker API is ergonomic and consistent
2. fromToken correctly extracts scopes from claims
3. InsufficientScopeError includes helpful details
4. No mutation of internal state between checks
5. Proper re-export from index.ts

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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/scope-checker.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n033 Scope Checker SDK: ${result.status}`);
}

main().catch(console.error);
