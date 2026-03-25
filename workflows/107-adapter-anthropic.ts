/**
 * 107-adapter-anthropic.ts
 *
 * Domain 13: Discovery & Ecosystem
 * Anthropic tool-use adapter for relayauth tools
 *
 * Depends on: 104
 * Run: agent-relay run workflows/107-adapter-anthropic.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('107-adapter-anthropic')
  .description('Anthropic tool-use adapter for relayauth tools')
  .pattern('dag')
  .channel('wf-relayauth-107')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design Anthropic adapter, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for Anthropic tool-use adapter',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement Anthropic tool-use adapter',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review adapter for Anthropic API compatibility',
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

  .step('read-openai-adapter', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/ai/src/adapters/openai.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-adapter-base', 'read-tools', 'read-types', 'read-openai-adapter'],
    task: `Write tests for the Anthropic tool-use adapter.

Base adapter:
{{steps.read-adapter-base.output}}

Tools:
{{steps.read-tools.output}}

Types:
{{steps.read-types.output}}

OpenAI adapter (reference for pattern):
{{steps.read-openai-adapter.output}}

Write to ${ROOT}/packages/ai/src/__tests__/adapter-anthropic.test.ts.
Use node:test + node:assert/strict.

Test:
1. createAnthropicTools(config) returns Anthropic Tool[] array
2. Each tool has name, description, input_schema (JSON Schema)
3. input_schema uses Anthropic's format (type: 'object', properties, required)
4. handleToolUse(name, input) routes to correct adapter method
5. handleToolUse returns ToolResultBlockParam content
6. Content is array of { type: 'text', text: JSON } blocks
7. Error results use is_error: true
8. createToolHandler(config) returns { tools, handleToolUse } bundle`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/ai/src/__tests__/adapter-anthropic.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-adapter-base', 'read-tools', 'read-types'],
    task: `Implement the Anthropic tool-use adapter.

Base adapter:
{{steps.read-adapter-base.output}}

Tools:
{{steps.read-tools.output}}

Types:
{{steps.read-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/ai/src/adapters/anthropic.ts:

import { RelayAuthAdapter, AdapterConfig } from '../adapter.js';
import { RELAYAUTH_TOOLS } from '../tools.js';

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: object; required?: string[] };
}

interface ToolResultContent {
  type: 'text';
  text: string;
}

export function createAnthropicTools(config: AdapterConfig): AnthropicTool[]
- Convert RELAYAUTH_TOOLS to Anthropic tool format
- input_schema from JSON Schema parameters

export function createToolHandler(config: AdapterConfig): {
  tools: AnthropicTool[];
  handleToolUse: (name: string, input: Record<string, unknown>) => Promise<{
    content: ToolResultContent[];
    is_error?: boolean;
  }>;
}
- handleToolUse routes to adapter methods
- Returns content blocks with JSON text
- On error: is_error: true

Export from ${ROOT}/packages/ai/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/ai/src/adapters/anthropic.ts && echo "anthropic OK" || echo "anthropic MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-anthropic.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the Anthropic tool-use adapter.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read ${ROOT}/packages/ai/src/adapters/anthropic.ts and the tests. Check:
1. Tool format matches Anthropic's Tool interface exactly
2. input_schema uses proper JSON Schema (not Zod)
3. Result format uses content blocks with text type
4. is_error flag set correctly on failures
5. Consistent pattern with OpenAI and Vercel adapters
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
cd ${ROOT} && node --test --import tsx packages/ai/src/__tests__/adapter-anthropic.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n107 Adapter Anthropic: ${result.status}`);
}

main().catch(console.error);
