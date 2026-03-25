/**
 * 103-openapi-to-scopes.ts
 *
 * Domain 13: Discovery & Ecosystem
 * Auto-generate relayauth scopes from an OpenAPI spec
 *
 * Depends on: 031, 004, 069
 * Run: agent-relay run workflows/103-openapi-to-scopes.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('103-openapi-to-scopes')
  .description('Auto-generate relayauth scopes from OpenAPI specs')
  .pattern('dag')
  .channel('wf-relayauth-103')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design OpenAPI-to-scopes generator, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for OpenAPI scope generator',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement OpenAPI-to-scopes generator',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review scope generator for correctness and edge cases',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-scope-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/scope-format.md 2>/dev/null || cat ${ROOT}/specs/scope-format-spec.md 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-scope-parser', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/scopes.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-cli-framework', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/cli/src/index.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-scope-spec', 'read-scope-parser', 'read-scope-types', 'read-test-helpers'],
    task: `Write tests for the OpenAPI-to-scopes generator.

Scope spec:
{{steps.read-scope-spec.output}}

Scope parser:
{{steps.read-scope-parser.output}}

Scope types:
{{steps.read-scope-types.output}}

Write to ${ROOT}/packages/sdk/src/__tests__/openapi-scopes.test.ts.
Use node:test + node:assert/strict.

Test:
1. generateScopes(openapiSpec) parses a minimal OpenAPI spec
2. GET /users -> {service}:users:read
3. POST /users -> {service}:users:write
4. PUT /users/{id} -> {service}:users:write:/users/{id}
5. DELETE /users/{id} -> {service}:users:delete:/users/{id}
6. Nested paths: GET /orgs/{id}/members -> {service}:orgs.members:read
7. Service name extracted from info.title (kebab-cased)
8. Handles x-relayauth-scope custom extension override
9. Returns ScopeDefinition[] with descriptions from operation summary`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/src/__tests__/openapi-scopes.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-scope-spec', 'read-scope-parser', 'read-scope-types'],
    task: `Implement the OpenAPI-to-scopes generator.

Scope spec:
{{steps.read-scope-spec.output}}

Scope parser:
{{steps.read-scope-parser.output}}

Scope types:
{{steps.read-scope-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/sdk/src/openapi-scopes.ts:

export interface ScopeDefinition {
  scope: string;          // e.g. "myapi:users:read"
  description: string;    // from operation summary
  method: string;         // HTTP method
  path: string;           // OpenAPI path
  approval: 'session' | 'explicit';  // GET=session, mutating=explicit
}

export function generateScopes(spec: OpenAPISpec, serviceName?: string): ScopeDefinition[]
- Parse OpenAPI paths and operations
- Map HTTP methods: GET->read, POST->write, PUT->write, PATCH->write, DELETE->delete
- Convert paths to scope format: /orgs/{id}/members -> orgs.members
- Use x-relayauth-scope extension if present on operation
- Derive service name from spec.info.title (kebab-case) if not provided

Export from ${ROOT}/packages/sdk/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/src/openapi-scopes.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/openapi-scopes.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the OpenAPI-to-scopes generator.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/sdk/src/openapi-scopes.ts and the tests. Check:
1. Scope strings conform to relayauth format: {plane}:{resource}:{action}:{path?}
2. Path parameter handling is correct (/{id}/ segments)
3. Nested resources properly dot-separated
4. x-relayauth-scope extension takes priority over auto-generation
5. Edge cases: root path, trailing slashes, duplicate scopes
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
cd ${ROOT} && node --test --import tsx packages/sdk/src/__tests__/openapi-scopes.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n103 OpenAPI-to-Scopes: ${result.status}`);
}

main().catch(console.error);
