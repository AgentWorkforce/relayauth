/**
 * 109-a2a-discovery-bridge.ts
 *
 * Domain 13: Discovery & Ecosystem
 * Bridge A2A agent cards to/from agent-configuration discovery
 *
 * Depends on: 102, 076
 * Run: agent-relay run workflows/109-a2a-discovery-bridge.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('109-a2a-discovery-bridge')
  .description('Bridge A2A agent cards to agent-configuration discovery')
  .pattern('dag')
  .channel('wf-relayauth-109')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan A2A discovery bridge, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for A2A discovery bridge',
    cwd: ROOT,
  })
  .agent('impl-bridge', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement A2A-to-agent-configuration bridge',
    cwd: ROOT,
  })
  .agent('impl-route', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement server routes for bridge endpoints',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review bridge for protocol correctness and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-discovery-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/discovery.ts`,
    captureOutput: true,
  })

  .step('read-discovery-route', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/discovery.ts 2>/dev/null || grep -rl "agent-configuration" ${ROOT}/packages/server/src/routes/ 2>/dev/null | head -1 | xargs cat 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relaycast-a2a', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/engine/a2a.ts 2>/dev/null | head -80 || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relaycast-a2a-types', {
    type: 'deterministic',
    command: `grep -A 20 "interface A2aAgentCard" ${RELAYCAST}/packages/server/src/engine/a2a.ts 2>/dev/null || echo "TYPE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-relaycast-integration', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/integrations/relaycast.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-discovery-types', 'read-discovery-route', 'read-relaycast-a2a', 'read-relaycast-a2a-types', 'read-relaycast-integration'],
    task: `Plan the A2A discovery bridge.

Discovery types:
{{steps.read-discovery-types.output}}

Discovery route:
{{steps.read-discovery-route.output}}

Relaycast A2A engine:
{{steps.read-relaycast-a2a.output}}

A2A agent card type:
{{steps.read-relaycast-a2a-types.output}}

Write a plan to ${ROOT}/docs/109-plan.md covering:
1. agentCardToConfiguration(card): convert A2A agent card -> AgentConfiguration
   - Map skills -> supported scopes
   - Map capabilities -> supported features
   - Generate auth endpoints from card.url
2. configurationToAgentCard(config): convert AgentConfiguration -> A2A agent card
   - Map scopes -> skills
   - Include relayauth URL as RPC endpoint
3. GET /v1/discovery/agent-card — serve relayauth as an A2A agent card
4. POST /v1/discovery/bridge — accept an A2A agent card URL, return AgentConfiguration
5. How this enables: A2A agents discover relayauth, relayauth discovers A2A agents`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-discovery-types', 'read-relaycast-a2a-types'],
    task: `Write tests for the A2A discovery bridge.

Plan:
{{steps.plan.output}}

Discovery types:
{{steps.read-discovery-types.output}}

A2A types:
{{steps.read-relaycast-a2a-types.output}}

Write to ${ROOT}/packages/sdk/typescript/src/__tests__/a2a-bridge.test.ts.
Use node:test + node:assert/strict.

Test:
1. agentCardToConfiguration(card) maps skills to scope definitions
2. agentCardToConfiguration sets auth endpoints from card.url
3. configurationToAgentCard(config) maps scopes to skills
4. configurationToAgentCard includes relayauth metadata
5. Round-trip: card -> config -> card preserves essential info
6. Handles missing optional fields gracefully
7. Rejects cards without required fields (name, url)`,
    verification: { type: 'exit_code' },
  })

  .step('implement-bridge', {
    agent: 'impl-bridge',
    dependsOn: ['plan', 'read-discovery-types', 'read-relaycast-a2a-types'],
    task: `Implement the A2A discovery bridge functions.

Plan:
{{steps.plan.output}}

Discovery types:
{{steps.read-discovery-types.output}}

A2A types:
{{steps.read-relaycast-a2a-types.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/sdk/typescript/src/a2a-bridge.ts:

export function agentCardToConfiguration(card: A2aAgentCard): AgentConfiguration
- Map card.skills to scope definitions
- Derive endpoints from card.url
- Set auth methods based on card.capabilities

export function configurationToAgentCard(config: AgentConfiguration, name: string): A2aAgentCard
- Map scopes to skills with descriptions
- Set url to config token_endpoint base
- Include provider metadata

Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-routes', {
    agent: 'impl-route',
    dependsOn: ['plan', 'read-discovery-route'],
    task: `Implement the bridge server routes.

Plan:
{{steps.plan.output}}

Discovery route:
{{steps.read-discovery-route.output}}

Create or update ${ROOT}/packages/server/src/routes/discovery.ts to add:

GET /v1/discovery/agent-card
- Return this relayauth server as an A2A agent card
- Use configurationToAgentCard() with server config

POST /v1/discovery/bridge
- Accept { url: string } body
- Fetch /.well-known/agent-card.json from that URL
- Convert via agentCardToConfiguration()
- Return the AgentConfiguration

Both routes should handle errors (unreachable URL, invalid card).`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-bridge', 'implement-routes'],
    command: `test -f ${ROOT}/packages/sdk/typescript/src/a2a-bridge.ts && echo "bridge OK" || echo "bridge MISSING"; test -f ${ROOT}/packages/sdk/typescript/src/__tests__/a2a-bridge.test.ts && echo "tests OK" || echo "tests MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/a2a-bridge.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the A2A discovery bridge.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the bridge functions and routes. Check:
1. Mapping preserves all relevant metadata (no lossy conversions)
2. Bridge route validates input URL (no SSRF via arbitrary URL fetch)
3. Agent card output matches A2A spec format
4. Error handling for unreachable/invalid external services
5. No credential leaks in agent card response
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
cd ${ROOT} && node --test --import tsx packages/sdk/typescript/src/__tests__/a2a-bridge.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n109 A2A Discovery Bridge: ${result.status}`);
}

main().catch(console.error);
