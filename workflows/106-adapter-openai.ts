/**
 * 106-adapter-openai.ts
 *
 * Domain 13: Discovery & Ecosystem
 * OpenAI function-calling adapter for relayauth tools
 *
 * Depends on: 104
 * Run: agent-relay run workflows/106-adapter-openai.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('106-adapter-openai')
  .description('OpenAI function-calling adapter for relayauth tools')
  .pattern('dag')
  .channel('wf-relayauth-106')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design OpenAI adapter, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for OpenAI function-calling adapter',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement OpenAI function-calling adapter',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review adapter for OpenAI API compatibility',
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

  .step('read-vercel-adapter', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/ai/src/adapters/vercel.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-adapter-base', 'read-tools', 'read-types', 'read-vercel-adapter'],
    task: `Write tests for the OpenAI function-calling adapter.

Base adapter:
{{steps.read-adapter-base.output}}

Tools:
{{steps.read-tools.output}}

Types:
{{steps.read-types.output}}

Vercel adapter (reference for pattern):
{{steps.read-vercel-adapter.output}}

Write to ${ROOT}/packages/ai/src/__tests__/adapter-openai.test.ts.
Use node:test + node:assert/strict.

Test:
1. createOpenAITools(config) returns ChatCompletionTool[] array
2. Each tool has type: 'function', function: { name, description, parameters }
3. Parameters use JSON Schema format (not Zod)
4. handleToolCall(name, args) routes to correct adapter method
5. handleToolCall returns JSON string (OpenAI expects string results)
6. Unknown tool name returns error result
7. createToolHandler(config) returns { tools, handleToolCall } bundle`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/ai/src/__tests__/adapter-openai.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-adapter-base', 'read-tools', 'read-types'],
    task: `Implement the OpenAI function-calling adapter.

Base adapter:
{{steps.read-adapter-base.output}}

Tools:
{{steps.read-tools.output}}

Types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/ai/src/adapters/openai.ts:

import { RelayAuthAdapter, AdapterConfig } from '../adapter.js';
import { RELAYAUTH_TOOLS } from '../tools.js';

interface ChatCompletionTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export function createOpenAITools(config: AdapterConfig): ChatCompletionTool[]
- Convert RELAYAUTH_TOOLS to OpenAI function format
- Parameters already in JSON Schema from tools.ts

export function createToolHandler(config: AdapterConfig): {
  tools: ChatCompletionTool[];
  handleToolCall: (name: string, args: string) => Promise<string>;
}
- handleToolCall parses JSON args, routes to adapter method
- Returns JSON.stringify'd result

Export from ${ROOT}/packages/ai/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/ai/src/adapters/openai.ts && echo "openai OK" || echo "openai MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-openai.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the OpenAI function-calling adapter.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/ai/src/adapters/openai.ts and the tests. Check:
1. Tool format matches OpenAI's ChatCompletionTool exactly
2. handleToolCall properly parses JSON args (handles malformed input)
3. Results are JSON strings as OpenAI expects
4. No OpenAI SDK dependency required (just types)
5. Consistent pattern with Vercel adapter
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
cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-openai.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n106 Adapter OpenAI: ${result.status}`);
}

main().catch(console.error);
