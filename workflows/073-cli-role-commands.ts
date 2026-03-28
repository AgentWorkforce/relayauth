/**
 * 073-cli-role-commands.ts
 *
 * Domain 8: CLI
 * relayauth role create/list/assign/remove
 *
 * Depends on: 069, 061
 * Run: agent-relay run workflows/073-cli-role-commands.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('073-cli-role-commands')
  .description('relayauth role create/list/assign/remove')
  .pattern('dag')
  .channel('wf-relayauth-073')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design role CLI commands, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CLI role commands',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CLI role commands',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CLI role commands for correctness and UX',
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

  .step('read-rbac-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/rbac.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-cli-framework', 'read-sdk-client', 'read-rbac-types', 'read-test-helpers'],
    task: `Write tests for CLI role commands.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Write failing tests to ${ROOT}/packages/cli/src/__tests__/role-commands.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. "role create --name admin --scope relaycast:*:*:*" creates a role
2. "role create" requires --name flag
3. "role list" lists all roles in table format
4. "role list --format json" outputs JSON
5. "role assign <role-id> --identity <identity-id>" assigns role
6. "role remove <role-id> --identity <identity-id>" removes role
7. "role get <role-id>" displays role details with scopes
8. Commands error gracefully when not logged in`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/role-commands.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-framework', 'read-sdk-client', 'read-rbac-types'],
    task: `Implement CLI role commands to make the tests pass.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

RBAC types:
{{steps.read-rbac-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/cli/src/commands/role.ts with subcommands:
- role create --name <name> --scope <scope>... [--description <desc>]
- role list [--format json|table]
- role get <role-id>
- role assign <role-id> --identity <identity-id>
- role remove <role-id> --identity <identity-id>

Each command should:
1. Load credentials, create RelayAuthClient
2. Call the appropriate SDK method
3. Format and display output
4. Handle errors gracefully

Register all commands in the CLI framework.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/commands/role.ts && echo "role.ts OK" || echo "role.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/role-commands.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CLI role commands implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Role CRUD operations are complete
2. Role assignment/removal calls correct SDK methods
3. Scope list is displayed properly in role details
4. Table formatting shows role name, description, scope count
5. Error messages are clear and actionable

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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/role-commands.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n073 CLI Role Commands: ${result.status}`);
}

main().catch(console.error);
