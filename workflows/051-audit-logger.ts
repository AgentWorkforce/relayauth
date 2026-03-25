/**
 * 051-audit-logger.ts
 *
 * Domain 6: Audit & Observability
 * Core audit logging: write entries to D1 on every auth event
 *
 * Depends on: 006
 * Run: agent-relay run workflows/051-audit-logger.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('051-audit-logger')
  .description('Core audit logging: write entries to D1 on every auth event')
  .pattern('dag')
  .channel('wf-relayauth-051')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit logger engine, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for audit logger',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement audit logger engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review audit logger for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit.md`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
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
    dependsOn: ['read-audit-spec', 'read-audit-types', 'read-test-helpers'],
    task: `Write tests for the audit logger engine.
    - Every audit entry includes sponsorId and sponsorChain
    - New event types: "budget.exceeded", "budget.alert", "scope.escalation_denied"
    - Budget breach events include: identity, budget config, actual usage, action attempted


Audit spec:
{{steps.read-audit-spec.output}}

Audit types:
{{steps.read-audit-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/audit-logger.test.ts.
    - Every audit entry includes sponsorId and sponsorChain
    - New event types: "budget.exceeded", "budget.alert", "scope.escalation_denied"
    - Budget breach events include: identity, budget config, actual usage, action attempted

Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. writeAuditEntry() writes an entry to D1
2. writeAuditEntry() generates a unique ID and timestamp
3. writeAuditEntry() validates required fields (action, identityId, orgId, result)
4. createAuditMiddleware() logs auth events automatically
5. Batch writing: flushAuditBatch() writes multiple entries in one transaction
6. Handles D1 write failures gracefully (does not throw, logs error)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/audit-logger.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-types', 'read-env'],
    task: `Implement the audit logger engine to make the tests pass.
    - Every audit entry includes sponsorId and sponsorChain
    - New event types: "budget.exceeded", "budget.alert", "scope.escalation_denied"
    - Budget breach events include: identity, budget config, actual usage, action attempted


Audit spec:
{{steps.read-audit-spec.output}}

Audit types:
{{steps.read-audit-types.output}}

Env bindings:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/engine/audit-logger.ts:
    - Every audit entry includes sponsorId and sponsorChain
    - New event types: "budget.exceeded", "budget.alert", "scope.escalation_denied"
    - Budget breach events include: identity, budget config, actual usage, action attempted

1. writeAuditEntry(db: D1Database, entry: Partial<AuditEntry>) — insert into audit_log table
    - Every audit entry includes sponsorId and sponsorChain
    - New event types: "budget.exceeded", "budget.alert", "scope.escalation_denied"
    - Budget breach events include: identity, budget config, actual usage, action attempted

2. flushAuditBatch(db: D1Database, entries: Partial<AuditEntry>[]) — batch insert
3. createAuditMiddleware() — Hono middleware that logs auth events
4. Generate unique IDs with "aud_" prefix
5. Auto-set timestamp if not provided
6. Validate required fields, throw on missing
7. Graceful error handling — catch D1 failures, log them, don't crash the request

Export from the package.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/audit-logger.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-logger.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the audit logger implementation.
    - Every audit entry includes sponsorId and sponsorChain
    - New event types: "budget.exceeded", "budget.alert", "scope.escalation_denied"
    - Budget breach events include: identity, budget config, actual usage, action attempted


Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover all spec requirements
2. Implementation matches audit spec
3. Error handling is correct — D1 failures must not crash requests
4. Types are properly exported
5. Consistent with existing patterns in the codebase

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-logger.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n051 Audit Logger: ${result.status}`);
}

main().catch(console.error);
