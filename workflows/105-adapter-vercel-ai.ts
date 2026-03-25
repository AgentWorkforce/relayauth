/**
 * 105-adapter-vercel-ai.ts
 *
 * Domain 13: Discovery & Ecosystem
 * Vercel AI SDK adapter — relayauth tools as AI SDK tools
 *
 * Depends on: 104
 * Run: agent-relay run workflows/105-adapter-vercel-ai.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('105-adapter-vercel-ai')
  .description('Vercel AI SDK adapter for relayauth tools')
  .pattern('dag')
  .channel('wf-relayauth-105')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design Vercel AI SDK adapter, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for Vercel AI SDK adapter',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement Vercel AI SDK adapter',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review adapter for Vercel AI SDK compatibility and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-adapter-base', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/ai/src/adapter.ts`,
    captureOutput: true,
  })

  .step('read-tools', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/ai/src/tools.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/ai/src/types.ts`,
    captureOutput: true,
  })

  .step('read-ai-index', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/ai/src/index.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-adapter-base', 'read-tools', 'read-types'],
    task: `Write tests for the Vercel AI SDK adapter.

Base adapter:
{{steps.read-adapter-base.output}}

Tools:
{{steps.read-tools.output}}

Types:
{{steps.read-types.output}}

Write to ${ROOT}/packages/ai/src/__tests__/adapter-vercel.test.ts.
Use node:test + node:assert/strict.

Test:
1. createRelayAuthTools(config) returns Record<string, CoreTool>
2. Each tool has description, parameters (zod schema), execute function
3. discover_service tool calls adapter.discover() and returns config
4. register_agent tool calls adapter.registerAgent() with params
5. execute_with_auth tool adds auth headers and proxies the request
6. Tools are compatible with Vercel AI SDK's tool() format
7. Error handling: tool execute returns error in result, doesn't throw`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/ai/src/__tests__/adapter-vercel.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-adapter-base', 'read-tools', 'read-types'],
    task: `Implement the Vercel AI SDK adapter.

Base adapter:
{{steps.read-adapter-base.output}}

Tools:
{{steps.read-tools.output}}

Types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/ai/src/adapters/vercel.ts:

import { tool } from 'ai';  // from Vercel AI SDK
import { z } from 'zod';
import { RelayAuthAdapter, AdapterConfig } from '../adapter.js';

export function createRelayAuthTools(config: AdapterConfig): Record<string, CoreTool> {
  const adapter = new RelayAuthAdapter(config);
  return {
    discover_service: tool({
      description: 'Discover a relayauth server capabilities',
      parameters: z.object({ url: z.string().optional() }),
      execute: async (params) => adapter.discover(params.url),
    }),
    register_agent: tool({
      description: 'Register a new agent identity',
      parameters: z.object({
        name: z.string(),
        scopes: z.array(z.string()),
        sponsor: z.string(),
      }),
      execute: async (params) => adapter.registerAgent(params.name, params.scopes, params.sponsor),
    }),
    execute_with_auth: tool({
      description: 'Make an authenticated HTTP request',
      parameters: z.object({
        url: z.string(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        body: z.any().optional(),
      }),
      execute: async (params) => adapter.executeWithAuth(params.url, params.method, params.body),
    }),
    check_scope: tool({
      description: 'Check if the agent has a specific scope',
      parameters: z.object({ scope: z.string() }),
      execute: async (params) => adapter.checkScope(params.scope),
    }),
  };
}

Export from ${ROOT}/packages/ai/src/index.ts.
Add 'ai' and 'zod' as peerDependencies in packages/ai/package.json.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/ai/src/adapters/vercel.ts && echo "vercel OK" || echo "vercel MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-vercel.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the Vercel AI SDK adapter.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/ai/src/adapters/vercel.ts and the tests. Check:
1. Tool definitions match Vercel AI SDK's CoreTool interface
2. Zod schemas properly validate inputs
3. Error handling wraps exceptions in ToolResult
4. No secrets or tokens exposed in tool results
5. Adapter reuses RelayAuthAdapter instance (not per-call)
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
cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-vercel.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n105 Adapter Vercel AI: ${result.status}`);
}

main().catch(console.error);
