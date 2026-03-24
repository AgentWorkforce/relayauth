/**
 * 071-cli-identity-commands.ts
 *
 * Domain 8: CLI
 * relayauth agent create/list/get/suspend/retire
 *
 * Depends on: 069, 059
 * Run: agent-relay run workflows/071-cli-identity-commands.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('071-cli-identity-commands')
  .description('relayauth agent create/list/get/suspend/retire')
  .pattern('dag')
  .channel('wf-relayauth-071')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design identity CLI commands, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CLI identity commands',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CLI identity commands',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CLI identity commands for correctness and UX',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-cli-framework', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/src/lib/cli.ts && echo "=== OUTPUT ===" && cat ${ROOT}/packages/cli/src/lib/output.ts && echo "=== CREDS ===" && cat ${ROOT}/packages/cli/src/lib/credentials.ts`,
    captureOutput: true,
  })

  .step('read-sdk-identities', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/client.ts`,
    captureOutput: true,
  })

  .step('read-identity-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-cli-framework', 'read-sdk-identities', 'read-identity-types', 'read-test-helpers'],
    task: `Write tests for CLI identity commands.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-identities.output}}

Identity types:
{{steps.read-identity-types.output}}

Write failing tests to ${ROOT}/packages/cli/src/__tests__/identity-commands.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. "agent create" sends correct request to SDK with name and scopes
2. "agent create --name foo --scope relaycast:*:*:*" passes args correctly
3. "agent list" calls SDK list and formats output as table
4. "agent list --format json" outputs JSON
5. "agent get <id>" fetches and displays identity details
6. "agent suspend <id> --reason maintenance" calls suspend
7. "agent retire <id>" calls retire with confirmation
8. Commands error gracefully when not logged in`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/identity-commands.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-framework', 'read-sdk-identities', 'read-identity-types'],
    task: `Implement CLI identity commands to make the tests pass.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-identities.output}}

Identity types:
{{steps.read-identity-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/cli/src/commands/agent.ts with subcommands:
- agent create --name <name> [--scope <scope>...] [--type agent|human|service]
- agent list [--format json|table]
- agent get <id>
- agent suspend <id> --reason <reason>
- agent retire <id>

Each command should:
1. Load credentials from config
2. Create RelayAuthClient with stored credentials
3. Call the appropriate SDK method
4. Format and display output using the output formatter

Register all commands in the CLI framework.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/commands/agent.ts && echo "agent.ts OK" || echo "agent.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/identity-commands.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CLI identity commands implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. All CRUD operations for identities are covered
2. Error handling for missing credentials
3. Output formatting for both table and JSON
4. Suspend requires --reason flag
5. Retire has confirmation prompt logic

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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/identity-commands.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n071 CLI Identity Commands: ${result.status}`);
}

main().catch(console.error);
