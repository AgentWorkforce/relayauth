/**
 * 072-cli-token-commands.ts
 *
 * Domain 8: CLI
 * relayauth token issue/revoke/introspect
 *
 * Depends on: 069, 060
 * Run: agent-relay run workflows/072-cli-token-commands.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('072-cli-token-commands')
  .description('relayauth token issue/revoke/introspect')
  .pattern('dag')
  .channel('wf-relayauth-072')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token CLI commands, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CLI token commands',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CLI token commands',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CLI token commands for correctness and security',
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

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-cli-framework', 'read-sdk-client', 'read-token-types', 'read-test-helpers'],
    task: `Write tests for CLI token commands.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

Token types:
{{steps.read-token-types.output}}

Write failing tests to ${ROOT}/packages/cli/src/__tests__/token-commands.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. "token issue --identity <id>" calls SDK issueToken and displays token pair
2. "token issue --identity <id> --scope relaycast:*:*:*" passes scopes
3. "token revoke <token-id>" calls SDK revokeToken
4. "token revoke --all --identity <id>" revokes all tokens for identity
5. "token introspect <token>" calls SDK introspect and displays claims
6. "token introspect" reads token from stdin when no arg
7. Token output redacts middle portion of token string for security
8. Commands error gracefully when not logged in`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/token-commands.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-framework', 'read-sdk-client', 'read-token-types'],
    task: `Implement CLI token commands to make the tests pass.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

Token types:
{{steps.read-token-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/cli/src/commands/token.ts with subcommands:
- token issue --identity <id> [--scope <scope>...] [--ttl <seconds>]
- token revoke <token-id> | --all --identity <id>
- token introspect [<token>] (reads from stdin if no arg)

Each command should:
1. Load credentials, create RelayAuthClient
2. Call the appropriate SDK method
3. Format output (redact token middle chars for display)
4. Handle errors gracefully

Register all commands in the CLI framework.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/commands/token.ts && echo "token.ts OK" || echo "token.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/token-commands.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CLI token commands implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Token issuance passes correct params to SDK
2. Token revocation handles both single and bulk revoke
3. Introspect correctly decodes and displays claims
4. Token strings are redacted in output for security
5. Stdin reading for introspect works correctly

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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/token-commands.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n072 CLI Token Commands: ${result.status}`);
}

main().catch(console.error);
