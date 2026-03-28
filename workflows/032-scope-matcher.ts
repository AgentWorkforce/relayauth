/**
 * 032-scope-matcher.ts
 *
 * Domain 4: Scopes & RBAC
 * Match requested scope against granted scopes (with wildcards/paths)
 *
 * Depends on: 031
 * Run: agent-relay run workflows/032-scope-matcher.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('032-scope-matcher')
  .description('Match requested scope against granted scopes (with wildcards/paths)')
  .pattern('dag')
  .channel('wf-relayauth-032')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design scope matcher algorithm, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for scope matcher',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement scope matcher',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope matcher for correctness and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-scope-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/scope-format.md`,
    captureOutput: true,
  })

  .step('read-scope-parser', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scope-parser.ts`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-scope-spec', 'read-scope-parser', 'read-scope-types'],
    task: `Write tests for the scope matcher module.
    - intersect(parentScopes, requestedScopes): return narrowed scopes for sub-agent
    - Scope escalation detection: if requested scope is broader than parent → error


Scope format spec:
{{steps.read-scope-spec.output}}

Scope parser (already implemented):
{{steps.read-scope-parser.output}}

Scope types:
{{steps.read-scope-types.output}}

Write failing tests to ${ROOT}/packages/sdk/typescript/src/__tests__/scope-matcher.test.ts.
    - intersect(parentScopes, requestedScopes): return narrowed scopes for sub-agent
    - Scope escalation detection: if requested scope is broader than parent → error

Use node:test + node:assert/strict.

Test these behaviors:
1. matchScope("relaycast:channel:read:*", ["relaycast:channel:read:*"]) → true (exact match)
2. matchScope("relaycast:channel:read:general", ["relaycast:*:*:*"]) → true (wildcard grant)
3. matchScope("relaycast:channel:write:*", ["relaycast:channel:read:*"]) → false (action mismatch)
4. matchScope("relayfile:fs:write:/src/api/foo.ts", ["relayfile:fs:write:/src/*"]) → true (path glob)
5. matchScope("relayfile:fs:write:/etc/passwd", ["relayfile:fs:write:/src/*"]) → false (path outside grant)
6. matchScope("cloud:workflow:run", ["*:*:*:*"]) → true (superuser wildcard)
7. matchScope("relaycast:channel:read:*", []) → false (no grants)
8. matchesAny(["relaycast:channel:read:*", "relayfile:fs:write:*"], ["relaycast:*:*:*"]) → partial match info
9. matchScope with manage action grants read+write+create+delete
10. Path matching: /src/api/* matches /src/api/foo but not /src/lib/foo`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/scope-matcher.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-scope-parser', 'read-scope-types'],
    task: `Implement the scope matcher to make the tests pass.
    - intersect(parentScopes, requestedScopes): return narrowed scopes for sub-agent
    - Scope escalation detection: if requested scope is broader than parent → error


Scope parser:
{{steps.read-scope-parser.output}}

Scope types:
{{steps.read-scope-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/sdk/typescript/src/scope-matcher.ts:
    - intersect(parentScopes, requestedScopes): return narrowed scopes for sub-agent
    - Scope escalation detection: if requested scope is broader than parent → error

- matchScope(requested: string, granted: string[]): boolean
- matchesAny(requested: string[], granted: string[]): { matched: string[]; denied: string[] }
- Internal: matchParsedScope(req: ParsedScope, grant: ParsedScope): boolean
- Wildcard rules: "*" matches anything at that level
- Path matching: /src/* matches /src/anything but not /other/thing
- "manage" action implies read+write+create+delete
- Use parseScope from scope-parser.ts

Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/scope-matcher.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/scope-matcher.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the scope matcher implementation.
    - intersect(parentScopes, requestedScopes): return narrowed scopes for sub-agent
    - Scope escalation detection: if requested scope is broader than parent → error


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Wildcard matching is secure (no path traversal bypasses)
2. "manage" action expansion is correct
3. Path glob matching handles edge cases (trailing slashes, double wildcards)
4. No false positives — denied scopes must never match
    - intersect(parentScopes, requestedScopes): return narrowed scopes for sub-agent
    - Scope escalation detection: if requested scope is broader than parent → error

5. Performance is acceptable for large grant sets

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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/scope-matcher.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n032 Scope Matcher: ${result.status}`);
}

main().catch(console.error);
