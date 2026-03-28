/**
 * 074-cli-audit-commands.ts
 *
 * Domain 8: CLI
 * relayauth audit query/export/tail
 *
 * Depends on: 069, 062
 * Run: agent-relay run workflows/074-cli-audit-commands.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('074-cli-audit-commands')
  .description('relayauth audit query/export/tail')
  .pattern('dag')
  .channel('wf-relayauth-074')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design audit CLI commands, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CLI audit commands',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CLI audit commands',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CLI audit commands for correctness and UX',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-cli-framework', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/src/lib/cli.ts && echo "=== OUTPUT ===" && cat ${ROOT}/packages/cli/src/lib/output.ts && echo "=== CREDS ===" && cat ${ROOT}/packages/cli/src/lib/credentials.ts`,
    captureOutput: true,
  })

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-audit-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-cli-framework', 'read-sdk-client', 'read-audit-types', 'read-test-helpers'],
    task: `Write tests for CLI audit commands.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

Audit types:
{{steps.read-audit-types.output}}

Write failing tests to ${ROOT}/packages/cli/src/__tests__/audit-commands.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. "audit query" lists recent audit entries in table format
2. "audit query --identity <id>" filters by identity
3. "audit query --action token.issued" filters by action
4. "audit query --from 2024-01-01 --to 2024-12-31" filters by date range
5. "audit query --format json" outputs JSON
6. "audit export --output audit.csv" exports to CSV file
7. "audit export --output audit.json --format json" exports to JSON file
8. "audit tail" streams new audit entries (polls with interval)
9. Commands error gracefully when not logged in`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/audit-commands.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-framework', 'read-sdk-client', 'read-audit-types'],
    task: `Implement CLI audit commands to make the tests pass.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

Audit types:
{{steps.read-audit-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/cli/src/commands/audit.ts with subcommands:
- audit query [--identity <id>] [--action <action>] [--from <date>] [--to <date>] [--format json|table] [--limit <n>]
- audit export --output <path> [--format json|csv] [--identity <id>] [--from <date>] [--to <date>]
- audit tail [--identity <id>] [--interval <ms>]

Each command should:
1. Load credentials, create RelayAuthClient
2. Build AuditQuery from CLI flags
3. Call SDK audit methods
4. Format output (table shows timestamp, action, identity, result)
5. Export writes to file; tail polls at interval

Register all commands in the CLI framework.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/commands/audit.ts && echo "audit.ts OK" || echo "audit.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/audit-commands.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CLI audit commands implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Query filters map correctly to AuditQuery type
2. Date parsing handles ISO format correctly
3. CSV export has proper headers and escaping
4. Tail command uses polling interval, not infinite loop
5. Table output shows key fields (timestamp, action, identity, result)

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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/audit-commands.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n074 CLI Audit Commands: ${result.status}`);
}

main().catch(console.error);
