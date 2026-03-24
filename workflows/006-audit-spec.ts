/**
 * 006-audit-spec.ts
 *
 * Domain 1: Foundation
 * Define audit log format, retention, query semantics
 *
 * Depends on: 001
 * Run: agent-relay run workflows/006-audit-spec.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('006-audit-spec')
  .description('Define audit log format, retention, query semantics')
  .pattern('dag')
  .channel('wf-relayauth-006')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit spec, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the audit log spec document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review audit spec for completeness and query correctness',
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
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-types'],
    task: `Design the audit log specification.

Architecture:
{{steps.read-architecture.output}}

Audit types:
{{steps.read-types.output}}

Write design outline to ${ROOT}/docs/audit-design.md covering:
- Audit entry format: all fields from AuditEntry
- Actions: all AuditAction values and when they fire
- Storage: D1 table schema, indexes
- Retention: configurable per-org, default 90 days
- Query semantics: filters, pagination, sorting
- Export: CSV and JSON formats
- Webhook notifications on audit events`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full audit log spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

Audit types:
{{steps.read-types.output}}

Write to ${ROOT}/specs/audit.md. Include:
- Audit entry schema with all fields
- When each AuditAction is triggered
- D1 table DDL (audit_logs table)
- Index strategy for common queries
- Query API: filters (identity, action, org, date range), cursor pagination
- Retention policy: per-org config, cleanup job
- Export formats: CSV columns, JSON structure
- Webhook payload format and delivery semantics`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/audit.md && wc -l ${ROOT}/specs/audit.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the audit log spec.

Read ${ROOT}/specs/audit.md and check:
1. All AuditAction types are documented with triggers
2. D1 schema supports all query patterns efficiently
3. Retention cleanup won't cause performance issues
4. Cursor pagination is correct (not offset-based)
5. Export format includes all necessary fields
6. Webhook delivery has retry semantics
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the audit log spec.

Reviewer feedback:
{{steps.review-spec.output}}

Read each issue from the reviewer feedback above. For each one:
1. Open the file mentioned
2. Make the specific fix described
3. Save the file

After all fixes, verify by reading the file again to confirm changes were applied.

Update ${ROOT}/specs/audit.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n006 Audit Spec: ${result.status}`);
}

main().catch(console.error);
