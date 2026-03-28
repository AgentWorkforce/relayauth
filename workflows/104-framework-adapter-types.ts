/**
 * 104-framework-adapter-types.ts
 *
 * Domain 13: Discovery & Ecosystem
 * @relayauth/ai package scaffold + shared adapter types
 *
 * Depends on: 033, 063, 101
 * Run: agent-relay run workflows/104-framework-adapter-types.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('104-framework-adapter-types')
  .description('Scaffold @relayauth/ai package with shared adapter types')
  .pattern('dag')
  .channel('wf-relayauth-104')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan @relayauth/ai package structure, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for shared adapter types',
    cwd: ROOT,
  })
  .agent('scaffolder', {
    cli: 'codex',
    preset: 'worker',
    role: 'Scaffold @relayauth/ai package structure',
    cwd: ROOT,
  })
  .agent('impl-types', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement shared adapter types and base adapter class',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review package structure and types for extensibility',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-sdk-verify', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-scope-checker', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/scopes.ts`,
    captureOutput: true,
  })

  .step('read-discovery-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/discovery.ts`,
    captureOutput: true,
  })

  .step('read-root-package', {
    type: 'deterministic',
    command: `cat ${ROOT}/package.json`,
    captureOutput: true,
  })

  .step('read-turbo-config', {
    type: 'deterministic',
    command: `cat ${ROOT}/turbo.json`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-sdk-client', 'read-sdk-verify', 'read-scope-checker', 'read-discovery-types', 'read-root-package', 'read-turbo-config'],
    task: `Plan the @relayauth/ai package.

SDK client:
{{steps.read-sdk-client.output}}

SDK verify:
{{steps.read-sdk-verify.output}}

Scope checker:
{{steps.read-scope-checker.output}}

Discovery types:
{{steps.read-discovery-types.output}}

Root package.json:
{{steps.read-root-package.output}}

Write a plan to ${ROOT}/docs/104-plan.md covering:
1. Package structure: packages/ai/ with src/, tsconfig, package.json
2. Shared types: AdapterTool, AdapterConfig, ToolResult
3. Base adapter class that wraps RelayAuthClient + TokenVerifier
4. Tool definitions that all adapters will expose:
   - discover_service: find a relayauth server by URL
   - register_agent: register an agent identity
   - request_scope: request a scope for the agent
   - execute_with_auth: make an authenticated request
   - check_scope: verify a scope is granted
5. How each framework adapter will extend the base`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('scaffold-package', {
    agent: 'scaffolder',
    dependsOn: ['plan'],
    task: `Scaffold the @relayauth/ai package.

Plan:
{{steps.plan.output}}

Root package.json:
{{steps.read-root-package.output}}

Turbo config:
{{steps.read-turbo-config.output}}

Create:
1. ${ROOT}/packages/ai/package.json — name: @relayauth/ai, main/types entries
2. ${ROOT}/packages/ai/tsconfig.json — extends root, references @relayauth/types and @relayauth/sdk
3. ${ROOT}/packages/ai/src/index.ts — barrel export (empty for now)
4. Add packages/ai to root package.json workspaces array
5. Add ai package to turbo.json pipeline if needed`,
    verification: { type: 'exit_code' },
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-sdk-verify', 'read-scope-checker'],
    task: `Write tests for the shared adapter types and base class.

Plan:
{{steps.plan.output}}

SDK verify:
{{steps.read-sdk-verify.output}}

Scope checker:
{{steps.read-scope-checker.output}}

Write to ${ROOT}/packages/ai/src/__tests__/adapter-base.test.ts.
Use node:test + node:assert/strict.

Test:
1. RelayAuthAdapter constructor accepts config (serverUrl, options)
2. getTools() returns array of AdapterTool definitions
3. Each tool has name, description, parameters (JSON Schema)
4. discover() fetches /.well-known/agent-configuration
5. registerAgent() calls SDK client to create identity
6. executeWithAuth() adds Bearer token to request headers
7. checkScope() delegates to ScopeChecker`,
    verification: { type: 'exit_code' },
  })

  .step('implement-types', {
    agent: 'impl-types',
    dependsOn: ['scaffold-package', 'plan', 'read-sdk-verify', 'read-scope-checker', 'read-discovery-types'],
    task: `Implement the shared adapter types and base class.

Plan:
{{steps.plan.output}}

SDK verify:
{{steps.read-sdk-verify.output}}

Scope checker:
{{steps.read-scope-checker.output}}

Discovery types:
{{steps.read-discovery-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create these files:

1. ${ROOT}/packages/ai/src/types.ts:
   - AdapterTool: { name, description, parameters: JSONSchema }
   - AdapterConfig: { serverUrl, apiKey?, autoDiscover? }
   - ToolResult: { success, data?, error? }

2. ${ROOT}/packages/ai/src/tools.ts:
   - RELAYAUTH_TOOLS constant: array of tool definitions
   - discover_service, register_agent, request_scope, execute_with_auth, check_scope

3. ${ROOT}/packages/ai/src/adapter.ts:
   - RelayAuthAdapter class
   - Constructor: stores config, lazy-inits SDK client
   - getTools(): returns RELAYAUTH_TOOLS
   - discover(): fetch agent-configuration
   - registerAgent(name, scopes, sponsor): create identity
   - executeWithAuth(url, method, body): add Bearer header
   - checkScope(scope): verify via ScopeChecker

4. Update ${ROOT}/packages/ai/src/index.ts with exports.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-types'],
    command: `test -f ${ROOT}/packages/ai/src/types.ts && echo "types OK" || echo "types MISSING"; test -f ${ROOT}/packages/ai/src/tools.ts && echo "tools OK" || echo "tools MISSING"; test -f ${ROOT}/packages/ai/src/adapter.ts && echo "adapter OK" || echo "adapter MISSING"; test -f ${ROOT}/packages/ai/src/__tests__/adapter-base.test.ts && echo "tests OK" || echo "tests MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-base.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the @relayauth/ai package scaffold and shared types.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read all files in ${ROOT}/packages/ai/src/. Check:
1. Tool definitions have proper JSON Schema parameters
2. Base adapter is extensible — framework adapters can override tool execution
3. Types are exported and importable from @relayauth/ai
4. No circular dependencies with @relayauth/sdk
5. Package.json has correct peer dependencies
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
cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-base.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n104 Framework Adapter Types: ${result.status}`);
}

main().catch(console.error);
