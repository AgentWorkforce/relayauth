/**
 * 021-identity-do.ts
 *
 * Domain 3: Identity Lifecycle
 * IdentityDO durable object — per-agent state
 *
 * Depends on: 001
 * Run: agent-relay run workflows/021-identity-do.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('021-identity-do')
  .description('IdentityDO durable object — per-agent state storage')
  .pattern('dag')
  .channel('wf-relayauth-021')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design IdentityDO durable object, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for IdentityDO durable object',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement IdentityDO durable object',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review IdentityDO for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-types', 'read-env', 'read-test-helpers'],
    task: `Write tests for the IdentityDO durable object.
    - sponsorId (required): human user ID who authorized this agent
    - sponsorChain: full delegation chain [human, parentAgent, thisAgent]
    - budget: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
    - budgetUsage: { actionsThisHour, costToday, lastResetAt } — tracked in DO storage
    - Auto-suspend: when budget exceeded, identity status → suspended + audit event


Identity types:
{{steps.read-types.output}}

Env bindings:
{{steps.read-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/identity-do.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test:
- IdentityDO can be instantiated
    - sponsorId (required): human user ID who authorized this agent
    - sponsorChain: full delegation chain [human, parentAgent, thisAgent]
    - budget: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
    - budgetUsage: { actionsThisHour, costToday, lastResetAt } — tracked in DO storage
    - Auto-suspend: when budget exceeded, identity status → suspended + audit event

- create(): stores identity in SQLite storage with all fields
- get(): returns stored identity by id
- update(): merges metadata, updates scopes, sets updatedAt
- suspend(): sets status to "suspended", records reason and timestamp
- reactivate(): sets status back to "active", clears suspendReason
- retire(): sets status to "retired" (permanent, cannot reactivate)
- delete(): removes identity from storage
- get() returns null for non-existent identity`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/identity-do.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-types', 'read-env'],
    task: `Implement the IdentityDO durable object.
    - sponsorId (required): human user ID who authorized this agent
    - sponsorChain: full delegation chain [human, parentAgent, thisAgent]
    - budget: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
    - budgetUsage: { actionsThisHour, costToday, lastResetAt } — tracked in DO storage
    - Auto-suspend: when budget exceeded, identity status → suspended + audit event


Identity types:
{{steps.read-types.output}}

Env bindings:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/durable-objects/identity-do.ts.
IdentityDO uses Cloudflare Durable Object SQLite storage.
    - sponsorId (required): human user ID who authorized this agent
    - sponsorChain: full delegation chain [human, parentAgent, thisAgent]
    - budget: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
    - budgetUsage: { actionsThisHour, costToday, lastResetAt } — tracked in DO storage
    - Auto-suspend: when budget exceeded, identity status → suspended + audit event

Methods: create, get, update, suspend, reactivate, retire, delete.
Store identity data as JSON in SQLite. Use this.ctx.storage.
Export the class and add export to ${ROOT}/packages/server/src/durable-objects/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/durable-objects/identity-do.ts && echo "identity-do.ts OK" || echo "identity-do.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/identity-do.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the IdentityDO implementation.
    - sponsorId (required): human user ID who authorized this agent
    - sponsorChain: full delegation chain [human, parentAgent, thisAgent]
    - budget: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
    - budgetUsage: { actionsThisHour, costToday, lastResetAt } — tracked in DO storage
    - Auto-suspend: when budget exceeded, identity status → suspended + audit event


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover all DO methods (create, get, update, suspend, reactivate, retire, delete)
2. SQLite storage is used correctly via this.ctx.storage
3. Status transitions are valid (active->suspended->active, active->retired is permanent)
4. Types match @relayauth/types identity types
5. Timestamps are set correctly on state changes

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/identity-do.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n021 Identity DO: ${result.status}`);
}

main().catch(console.error);
