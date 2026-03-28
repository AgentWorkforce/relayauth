/**
 * 062-sdk-client-audit.ts
 *
 * Domain 7: SDK & Verification
 * RelayAuthClient audit query methods
 *
 * Depends on: 052
 * Run: agent-relay run workflows/062-sdk-client-audit.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('062-sdk-client-audit')
  .description('RelayAuthClient audit query methods')
  .pattern('dag')
  .channel('wf-relayauth-062')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design SDK audit methods, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for SDK audit query methods',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement SDK audit query methods on RelayAuthClient',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review SDK audit methods for completeness and API consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/errors.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-client', 'read-audit-types', 'read-errors'],
    task: `Write tests for RelayAuthClient audit query methods.

Existing client:
{{steps.read-client.output}}

Audit types:
{{steps.read-audit-types.output}}

Errors:
{{steps.read-errors.output}}

Write failing tests to ${ROOT}/packages/sdk/typescript/src/__tests__/client-audit.test.ts.
Use node:test + node:assert/strict.

Test these methods on RelayAuthClient:
1. queryAudit(query: AuditQuery) — GET /v1/audit with query params
   Returns { entries: AuditEntry[], cursor?: string }
2. getIdentityActivity(identityId, options?) — GET /v1/identities/:id/activity
   Returns { entries: AuditEntry[], cursor?: string }
3. exportAudit(query, format) — POST /v1/audit/export
   format: 'json' | 'csv', returns string (raw export data)

Mock fetch to verify query params are serialized correctly.
Test pagination with cursor. Test empty results.
Test filter combinations: by action, identityId, date range.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/__tests__/client-audit.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-client', 'read-audit-types', 'read-errors'],
    task: `Add audit query methods to RelayAuthClient.

Existing client:
{{steps.read-client.output}}

Audit types:
{{steps.read-audit-types.output}}

Errors:
{{steps.read-errors.output}}

Tests to pass:
{{steps.write-tests.output}}

Add these methods to RelayAuthClient in ${ROOT}/packages/sdk/typescript/src/client.ts:
- queryAudit(query: AuditQuery): Promise<{ entries: AuditEntry[]; cursor?: string }>
- getIdentityActivity(identityId: string, options?: { limit?: number; cursor?: string; from?: string; to?: string }): Promise<{ entries: AuditEntry[]; cursor?: string }>
- exportAudit(query: AuditQuery, format: 'json' | 'csv'): Promise<string>

For queryAudit/getIdentityActivity: serialize AuditQuery fields as URL query params.
For exportAudit: POST with body { ...query, format }, return response as text.
Use existing _request helper. Export AuditQuery, AuditEntry from package index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/client.ts && echo "client.ts OK" || echo "client.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/client-audit.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the SDK audit query methods.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/typescript/src/client.ts and the test file. Check:
1. All 3 audit methods implemented correctly
2. Query params properly serialized (no undefined values sent)
3. Pagination cursor passed through correctly
4. exportAudit returns raw text, not parsed JSON
5. Date range filters (from/to) handled as ISO strings
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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/client-audit.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n062 SDK Client Audit: ${result.status}`);
}

main().catch(console.error);
