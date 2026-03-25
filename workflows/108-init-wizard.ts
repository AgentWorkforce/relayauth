/**
 * 108-init-wizard.ts
 *
 * Domain 13: Discovery & Ecosystem
 * npx relayauth init — interactive setup wizard
 *
 * Depends on: 069, 102, 103
 * Run: agent-relay run workflows/108-init-wizard.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('108-init-wizard')
  .description('Interactive npx relayauth init setup wizard')
  .pattern('dag')
  .channel('wf-relayauth-108')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design init wizard flow, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for init wizard',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement init wizard command',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review wizard for UX, correctness, and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-cli-index', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/src/index.ts`,
    captureOutput: true,
  })

  .step('read-cli-package', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/package.json`,
    captureOutput: true,
  })

  .step('read-openapi-scopes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/openapi-scopes.ts`,
    captureOutput: true,
  })

  .step('read-discovery-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/discovery.ts`,
    captureOutput: true,
  })

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/client.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-cli-index', 'read-openapi-scopes', 'read-discovery-types'],
    task: `Write tests for the relayauth init wizard.

CLI index:
{{steps.read-cli-index.output}}

OpenAPI scopes generator:
{{steps.read-openapi-scopes.output}}

Discovery types:
{{steps.read-discovery-types.output}}

Write to ${ROOT}/packages/cli/src/__tests__/init-wizard.test.ts.
Use node:test + node:assert/strict.

Test the init wizard logic (not interactive prompts — test the underlying functions):
1. detectFramework(cwd) detects Hono/Express/Next.js from package.json
2. detectOpenAPISpec(cwd) finds openapi.yaml/.json in common locations
3. generateConfig(options) produces relayauth.config.ts content
4. generateMiddleware(framework) produces framework-specific middleware code
5. generateScaffold(options) returns list of files to create
6. Config includes serverUrl, scopes (from OpenAPI if found), framework adapter`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/cli/src/__tests__/init-wizard.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-cli-index', 'read-openapi-scopes', 'read-discovery-types', 'read-sdk-client'],
    task: `Implement the relayauth init wizard.

CLI index:
{{steps.read-cli-index.output}}

OpenAPI scopes generator:
{{steps.read-openapi-scopes.output}}

Discovery types:
{{steps.read-discovery-types.output}}

SDK client:
{{steps.read-sdk-client.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/cli/src/commands/init.ts:

The init command should:
1. detectFramework(cwd) — check package.json for hono/express/next
2. detectOpenAPISpec(cwd) — look for openapi.yaml/json in root, docs/, specs/
3. If OpenAPI found, run generateScopes() to auto-create scope definitions
4. generateConfig() — create relayauth.config.ts with:
   - serverUrl (prompted or from env)
   - scopes array
   - framework adapter import
5. generateMiddleware(framework) — create auth middleware file for detected framework
6. generateScaffold() — return file list for confirmation

Export detectFramework, detectOpenAPISpec, generateConfig, generateMiddleware,
generateScaffold for testing.

Register the 'init' command in ${ROOT}/packages/cli/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/cli/src/commands/init.ts && echo "init OK" || echo "init MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/init-wizard.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the init wizard implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/cli/src/commands/init.ts and the tests. Check:
1. Framework detection is reliable (checks dependencies, not file names)
2. OpenAPI detection covers common locations
3. Generated config is valid TypeScript
4. Generated middleware is secure (no hardcoded secrets)
5. Scaffold doesn't overwrite existing files without warning
List issues to fix.`,
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
cd ${ROOT} && node --test --import tsx packages/cli/src/__tests__/init-wizard.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n108 Init Wizard: ${result.status}`);
}

main().catch(console.error);
