/**
 * 069-cli-framework.ts
 *
 * Domain 8: CLI
 * CLI framework: arg parsing, config file, output formatting
 *
 * Depends on: 001
 * Run: agent-relay run workflows/069-cli-framework.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('069-cli-framework')
  .description('CLI framework: arg parsing, config file, output formatting')
  .pattern('dag')
  .channel('wf-relayauth-069')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design CLI framework architecture, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for CLI framework',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement CLI framework: arg parser, config loader, output formatter',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CLI framework for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-cli-scaffold', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/package.json && echo "=== INDEX ===" && cat ${ROOT}/packages/cli/src/index.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/index.ts`,
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
    dependsOn: ['read-cli-scaffold', 'read-types', 'read-sdk-client', 'read-test-helpers'],
    task: `Write tests for the CLI framework module.

CLI scaffold:
{{steps.read-cli-scaffold.output}}

SDK client:
{{steps.read-sdk-client.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/cli/src/__tests__/framework.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. parseArgs parses --format json/table/plain flags
2. parseArgs parses --config path flag
3. loadConfig reads ~/.relayauth/config.json
4. loadConfig returns defaults when no config file exists
5. formatOutput renders JSON output correctly
6. formatOutput renders table output correctly
7. createCLI returns a CLI instance with command registration
8. CLI prints help text with --help flag`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/framework.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-scaffold', 'read-types'],
    task: `Implement the CLI framework to make the tests pass.

CLI scaffold:
{{steps.read-cli-scaffold.output}}

Types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create these files:
1. ${ROOT}/packages/cli/src/lib/args.ts — parseArgs(): parse process.argv for global flags (--format, --config, --help, --version)
2. ${ROOT}/packages/cli/src/lib/config.ts — loadConfig(): read ~/.relayauth/config.json, merge with defaults (baseUrl, format, token)
3. ${ROOT}/packages/cli/src/lib/output.ts — formatOutput(): render data as json/table/plain
4. ${ROOT}/packages/cli/src/lib/cli.ts — createCLI(): command registry, help text, dispatch
5. Update ${ROOT}/packages/cli/src/index.ts to wire up the CLI framework

Export all from a barrel ${ROOT}/packages/cli/src/lib/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/lib/args.ts && echo "args.ts OK" || echo "args.ts MISSING"; test -f ${ROOT}/packages/cli/src/lib/config.ts && echo "config.ts OK" || echo "config.ts MISSING"; test -f ${ROOT}/packages/cli/src/lib/output.ts && echo "output.ts OK" || echo "output.ts MISSING"; test -f ${ROOT}/packages/cli/src/lib/cli.ts && echo "cli.ts OK" || echo "cli.ts MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/framework.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the CLI framework implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover arg parsing, config loading, output formatting
2. Config file path uses os.homedir() for cross-platform
3. Output formatter handles json/table/plain correctly
4. CLI command registry supports subcommands
5. Types are properly exported

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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/framework.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n069 CLI Framework: ${result.status}`);
}

main().catch(console.error);
