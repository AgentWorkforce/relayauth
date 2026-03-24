/**
 * 054-audit-retention.ts
 *
 * Domain 6: Audit & Observability
 * Configurable retention: auto-delete old entries
 *
 * Depends on: 051
 * Run: agent-relay run workflows/054-audit-retention.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('054-audit-retention')
  .description('Configurable retention: auto-delete old entries')
  .pattern('dag')
  .channel('wf-relayauth-054')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit retention engine, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for audit retention',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement audit retention engine',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review audit retention for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-audit-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/audit-spec.md`,
    captureOutput: true,
  })

  .step('read-audit-logger', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/audit-logger.ts`,
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
    dependsOn: ['read-audit-spec', 'read-audit-logger', 'read-test-helpers'],
    task: `Write tests for the audit retention engine.

Audit spec:
{{steps.read-audit-spec.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/audit-retention.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.

Test these behaviors:
1. purgeExpiredEntries(db, retentionDays) deletes entries older than retentionDays
2. Default retention is 90 days
3. Per-org retention override is respected
4. purgeExpiredEntries returns count of deleted entries
5. getRetentionConfig(db, orgId) returns org-specific or default config
6. setRetentionConfig(db, orgId, days) updates org retention setting
7. Retention minimum is 7 days (rejects lower values)
8. Dry run mode: countExpiredEntries() returns count without deleting`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/audit-retention.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-audit-spec', 'read-audit-logger', 'read-env'],
    task: `Implement the audit retention engine to make the tests pass.

Audit spec:
{{steps.read-audit-spec.output}}

Audit logger engine:
{{steps.read-audit-logger.output}}

Env bindings:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/server/src/engine/audit-retention.ts:
1. purgeExpiredEntries(db, retentionDays?) — DELETE FROM audit_log WHERE timestamp < cutoff
2. countExpiredEntries(db, retentionDays?) — COUNT without deleting (dry run)
3. getRetentionConfig(db, orgId) — read from audit_retention_config table
4. setRetentionConfig(db, orgId, days) — upsert retention config
5. Default retention: 90 days
6. Minimum retention: 7 days (throw if lower)
7. Return { deletedCount } from purge

Export from the package.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/server/src/engine/audit-retention.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-retention.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the audit retention implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover default and per-org retention
2. SQL DELETE is safe and uses parameterized queries
3. Minimum retention is enforced
4. Dry run mode works correctly
5. Consistent with existing engine patterns

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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/audit-retention.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n054 Audit Retention: ${result.status}`);
}

main().catch(console.error);
