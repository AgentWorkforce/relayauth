/**
 * 084-d1-migrations.ts
 *
 * Domain 10: Hosted Server
 * All D1 migrations: identities, roles, policies, audit, api_keys
 *
 * Depends on: 042, 043, 044, 045, 051, 052, 053, 054, 055, 056, 057
 * Run: agent-relay run workflows/084-d1-migrations.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('084-d1-migrations')
  .description('All D1 migrations for relayauth: identities, roles, policies, audit, api_keys')
  .pattern('dag')
  .channel('wf-relayauth-084')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan D1 schema, review migrations, fix issues',
    cwd: ROOT,
  })
  .agent('migration-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write D1 migration SQL files',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write migration validation tests',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review migrations for correctness, indexes, and consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ──────────────────────────────────────────

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts && echo "=== RBAC ===" && cat ${ROOT}/packages/types/src/rbac.ts && echo "=== AUDIT ===" && cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-migrations', {
    type: 'deterministic',
    command: `ls ${RELAYCAST}/packages/server/src/db/migrations/ && echo "=== FIRST ===" && cat ${RELAYCAST}/packages/server/src/db/migrations/0001_*.sql 2>/dev/null | head -60`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-types', 'read-relaycast-migrations', 'read-env'],
    task: `Plan D1 migrations for relayauth.

Types:
{{steps.read-types.output}}

Relaycast migration pattern:
{{steps.read-relaycast-migrations.output}}

Write plan to ${ROOT}/docs/084-migrations-plan.md:
1. 0001_identities.sql — identities table
2. 0002_roles.sql — roles table
3. 0003_policies.sql — policies table + conditions
4. 0004_role_assignments.sql — identity-role junction
5. 0005_audit_log.sql — audit entries
6. 0006_api_keys.sql — org API keys
7. 0007_workspaces.sql — workspaces table
8. 0008_organizations.sql — organizations table
Include indexes, foreign keys, timestamps.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Implement ────────────────────────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan'],
    task: `Write migration validation tests.

Plan:
{{steps.plan.output}}

Write ${ROOT}/packages/server/src/__tests__/d1-migrations.test.ts:
- Test each migration SQL file exists
- Test SQL is valid (basic syntax check)
- Test all tables have created_at/updated_at
- Test indexes exist for common query patterns
Use node:test + node:assert/strict.`,
    verification: { type: 'exit_code' },
  })

  .step('write-migrations', {
    agent: 'migration-writer',
    dependsOn: ['plan'],
    task: `Write all D1 migration files.

Plan:
{{steps.plan.output}}

Types reference:
{{steps.read-types.output}}

Write to ${ROOT}/packages/server/src/db/migrations/:

0001_identities.sql:
CREATE TABLE identities (id TEXT PK, name TEXT, type TEXT, org_id TEXT, status TEXT DEFAULT 'active', scopes TEXT, metadata TEXT, created_at TEXT, updated_at TEXT, last_active_at TEXT, suspended_at TEXT, suspend_reason TEXT);
Indexes on org_id, status, type.

0002_roles.sql: roles table with id, name, description, scopes, org_id, workspace_id, built_in, created_at.

0003_policies.sql: policies table with id, name, effect, scopes, conditions (JSON), priority, org_id, workspace_id, created_at.

0004_role_assignments.sql: junction table identity_id + role_id, assigned_at.

0005_audit_log.sql: audit table with all AuditEntry fields. Indexes on identity_id, action, org_id, timestamp.

0006_api_keys.sql: api_keys with id, org_id, name, key_hash, scopes, created_at, expires_at, revoked_at.

0007_workspaces.sql: workspaces with id, name, org_id, created_at, updated_at.

0008_organizations.sql: organizations with id, name, created_at, updated_at.

Write ALL 8 migration files.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-migrations', 'write-tests'],
    command: `ls ${ROOT}/packages/server/src/db/migrations/*.sql 2>/dev/null | wc -l && echo "---" && ls ${ROOT}/packages/server/src/db/migrations/ 2>/dev/null && test -f ${ROOT}/packages/server/src/__tests__/d1-migrations.test.ts && echo "test OK" || echo "test MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Review + Fix ─────────────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/d1-migrations.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review D1 migrations.

Test results:
{{steps.run-tests.output}}

Typecheck:
{{steps.typecheck.output}}

Read all migration files in ${ROOT}/packages/server/src/db/migrations/.
Check:
1. All tables match type definitions
2. Proper indexes for query patterns
3. Foreign key relationships are correct
4. Timestamps on all tables
5. SQL syntax is valid D1/SQLite
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix migration issues.

Reviewer feedback:
{{steps.review.output}}

Test results:
{{steps.run-tests.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/d1-migrations.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n084 D1 Migrations: ${result.status}`);
}

main().catch(console.error);
