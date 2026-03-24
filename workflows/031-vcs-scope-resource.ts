/**
 * 031-vcs-scope-resource.ts
 *
 * Domain 4: Scopes & RBAC
 * Add VCS (version control) as a recognized resource type for relayfile scopes.
 * Extends the scope parser and matcher to handle relayfile:vcs:* scopes with
 * git ref pattern matching (refs/heads/*, refs/tags/*, etc.)
 *
 * Depends on: 004 (scope-format-spec), 031 (scope-parser)
 * Run: agent-relay run workflows/031-vcs-scope-resource.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('031-vcs-scope-resource')
  .description('Add VCS resource type to scope system with git ref pattern matching')
  .pattern('dag')
  .channel('wf-relayauth-031-vcs')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design VCS scope extension, review implementations',
    cwd: ROOT,
  })
  .agent('types-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement VCS types, scope parser extensions, and matcher',
    cwd: ROOT,
  })
  .agent('test-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for VCS scope parsing and matching',
    cwd: ROOT,
  })

  // ── Wave 1: Spec update ────────────────────────────────────────────
  .step('spec-update', {
    agent: 'architect',
    task: `Update specs/scope-format.md to include VCS resource type.

Read the existing spec. Add a new section "VCS Scope Matching" that covers:

1. New actions for relayfile:vcs:* scopes:
   - push — push commits to a ref
   - force-push — non-fast-forward push (destructive)
   - branch-create — create new branches
   - branch-delete — delete branches
   - tag — create/push tags

2. Path segment for VCS scopes represents git refs:
   - refs/heads/* → any branch
   - refs/heads/main → exactly the main branch
   - refs/heads/feat/* → branches under feat/
   - refs/tags/* → any tag
   - * → any ref

3. Matching rules:
   - Same prefix matching as filesystem paths (reuse existing logic)
   - refs/heads/* matches refs/heads/main, refs/heads/feat/foo
   - refs/heads/feat/* matches refs/heads/feat/foo but NOT refs/heads/main
   - No mid-ref wildcards (refs/*/main is invalid)

4. Scope templates:
   - relayfile:vcs-readonly — can push to any branch EXCEPT main/master
   - relayfile:vcs-full — can push to any branch including main
   - relayfile:vcs-feature-only — can only push to feat/* branches

5. Example deny scenario:
   Agent token has: ["relayfile:vcs:push:refs/heads/feat/*", "relayfile:vcs:branch-create:refs/heads/feat/*"]
   Agent tries: git push origin main
   Result: DENIED — no scope covers refs/heads/main
   Audit event: vcs.push.denied with ref, agent identity, sponsor chain

Also update the actions enum to include push, force-push, branch-create,
branch-delete, tag.`,
  })

  // ── Wave 2: Types + parser ────────────────────────────────────────
  .step('vcs-types', {
    agent: 'types-dev',
    dependsOn: ['spec-update'],
    task: `Add VCS-related types and extend the scope parser.

In packages/types/src/scope.ts:
1. Add 'push', 'force-push', 'branch-create', 'branch-delete', 'tag' to the Action type
2. Add VCS scope templates to the templates section
3. Add VcsAction type union

In packages/sdk/src/scopes.ts:
1. Update parseScope() to accept the new actions
2. Add matchVcsRef(granted, requested) function:
   - Reuses the same prefix matching logic as matchFsPath
   - refs/heads/* matches refs/heads/anything
   - Exact match for non-wildcard paths
3. Update matches() to use matchVcsRef for relayfile:vcs:* scopes
   (similar to how it uses matchFsPath for relayfile:fs:*)

Run: npm run build && npm run typecheck`,
  })

  // ── Wave 3: Tests ─────────────────────────────────────────────────
  .step('vcs-tests', {
    agent: 'test-dev',
    dependsOn: ['vcs-types'],
    task: `Write comprehensive tests for VCS scope parsing and matching.

In packages/types/src/__tests__/scope.test.ts (extend existing):
1. Test new actions are valid: push, force-push, branch-create, branch-delete, tag
2. Test VCS scope templates expand correctly

In packages/sdk/src/__tests__/vcs-scopes.test.ts (new file):
1. Parse tests:
   - "relayfile:vcs:push:refs/heads/*" parses correctly
   - "relayfile:vcs:force-push:refs/heads/main" parses correctly
   - "relayfile:vcs:push:refs/*/main" is INVALID (mid-ref wildcard)

2. Match tests — the critical "prevent push to main" scenarios:
   - Grant ["relayfile:vcs:push:refs/heads/feat/*"]
     Request "relayfile:vcs:push:refs/heads/feat/my-feature" → MATCH
   - Grant ["relayfile:vcs:push:refs/heads/feat/*"]
     Request "relayfile:vcs:push:refs/heads/main" → NO MATCH
   - Grant ["relayfile:vcs:push:refs/heads/*"]
     Request "relayfile:vcs:push:refs/heads/main" → MATCH (full branch access)
   - Grant ["relayfile:vcs:push:refs/heads/*"]
     Request "relayfile:vcs:force-push:refs/heads/main" → NO MATCH (different action)
   - Grant ["relayfile:vcs:push:refs/heads/*", "relayfile:vcs:force-push:refs/heads/feat/*"]
     Request "relayfile:vcs:force-push:refs/heads/feat/wip" → MATCH
     Request "relayfile:vcs:force-push:refs/heads/main" → NO MATCH

3. Delegation tests:
   - Parent has ["relayfile:vcs:push:refs/heads/*"]
     Child requests ["relayfile:vcs:push:refs/heads/feat/*"] → isSubsetOf = true
   - Parent has ["relayfile:vcs:push:refs/heads/feat/*"]
     Child requests ["relayfile:vcs:push:refs/heads/*"] → isSubsetOf = false (escalation!)

Run: npm run test`,
  })

  // ── Wave 4: Review ────────────────────────────────────────────────
  .step('review', {
    agent: 'architect',
    dependsOn: ['vcs-tests'],
    task: `Review all VCS scope work.

Verify:
1. Spec update is consistent with the existing scope-format.md style
2. New actions are properly validated in the parser
3. Ref pattern matching is consistent with filesystem path matching
4. The "prevent push to main" scenario works end-to-end through types → parser → matcher
5. Delegation correctly prevents scope escalation for VCS scopes
6. All tests pass: npm run test && npm run typecheck
7. No breaking changes to existing scope parsing/matching

Write review to docs/vcs-scope-review.md`,
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n031 VCS Scope Resource: ${result.status}`);
}

main().catch(console.error);
