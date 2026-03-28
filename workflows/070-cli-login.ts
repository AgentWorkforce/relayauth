/**
 * 070-cli-login.ts
 *
 * Domain 8: CLI
 * relayauth login — authenticate, store credentials
 *
 * Depends on: 069
 * Run: agent-relay run workflows/070-cli-login.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('070-cli-login')
  .description('relayauth login — authenticate, store credentials')
  .pattern('dag')
  .channel('wf-relayauth-070')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design login flow, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CLI login command',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CLI login command',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CLI login for security, UX, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-cli-framework', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/src/lib/cli.ts && echo "=== CONFIG ===" && cat ${ROOT}/packages/cli/src/lib/config.ts && echo "=== ARGS ===" && cat ${ROOT}/packages/cli/src/lib/args.ts`,
    captureOutput: true,
  })

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-cli-framework', 'read-sdk-client', 'read-test-helpers'],
    task: `Write tests for the CLI login command.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

Write failing tests to ${ROOT}/packages/cli/src/__tests__/login.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. login command stores API key to config file
2. login command stores base URL to config file
3. login command validates API key format (starts with "rla_")
4. login command rejects empty API key
5. login --check verifies stored credentials are valid
6. logout command removes stored credentials
7. login writes config to ~/.relayauth/config.json path
8. login with --token flag stores a bearer token instead of API key`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/login.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-framework', 'read-sdk-client'],
    task: `Implement the CLI login command to make the tests pass.

CLI framework:
{{steps.read-cli-framework.output}}

SDK client:
{{steps.read-sdk-client.output}}

Tests to pass:
{{steps.write-tests.output}}

Create these files:
1. ${ROOT}/packages/cli/src/commands/login.ts — login command: prompt for API key, validate format, store to config
2. ${ROOT}/packages/cli/src/commands/logout.ts — logout command: remove stored credentials
3. ${ROOT}/packages/cli/src/lib/credentials.ts — saveCredentials(), loadCredentials(), clearCredentials()

Register login and logout commands in the CLI framework.
API key format: must start with "rla_" prefix.
Store credentials at ~/.relayauth/config.json.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/commands/login.ts && echo "login.ts OK" || echo "login.ts MISSING"; test -f ${ROOT}/packages/cli/src/commands/logout.ts && echo "logout.ts OK" || echo "logout.ts MISSING"; test -f ${ROOT}/packages/cli/src/lib/credentials.ts && echo "credentials.ts OK" || echo "credentials.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/login.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CLI login implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Credentials are stored securely (not world-readable)
2. API key validation is correct (rla_ prefix)
3. Config directory is created if it doesn't exist
4. Login/logout UX is clean
5. Token-based auth is supported alongside API key

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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/login.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n070 CLI Login: ${result.status}`);
}

main().catch(console.error);
