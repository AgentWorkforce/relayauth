/**
 * 099-integration-guides.ts
 *
 * Domain 12: Docs & Landing
 * Integration guides for each plane: relaycast, relayfile, cloud
 *
 * Depends on: 076, 077, 078
 * Run: agent-relay run workflows/099-integration-guides.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('099-integration-guides')
  .description('Integration guides for each plane: relaycast, relayfile, cloud')
  .pattern('dag')
  .channel('wf-relayauth-099')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design integration guides, finalize after review',
    cwd: ROOT,
  })
  .agent('doc-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration guide documents',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review guides for accuracy and developer experience',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-relaycast-integration', {
    type: 'deterministic',
    command: `find ${ROOT}/packages/server/src -name "*relaycast*" -o -name "*integration*" | head -5 | xargs -I{} sh -c 'echo "=== {} ===" && cat {}'`,
    captureOutput: true,
  })

  .step('read-relayfile-integration', {
    type: 'deterministic',
    command: `find ${ROOT}/packages -name "*relayfile*" | head -5 | xargs -I{} sh -c 'echo "=== {} ===" && cat {}'`,
    captureOutput: true,
  })

  .step('read-sdk-middleware', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/index.ts && echo "=== verify ===" && cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('design-guides', {
    agent: 'architect',
    dependsOn: ['read-relaycast-integration', 'read-relayfile-integration', 'read-sdk-middleware', 'read-architecture'],
    task: `Design the integration guides.

Architecture:
{{steps.read-architecture.output}}

SDK middleware:
{{steps.read-sdk-middleware.output}}

Write outline to ${ROOT}/docs/099-guides-outline.md. Three guides:
1. Relaycast Integration: add relayauth to a Hono messaging server
2. Relayfile Integration: add relayauth to a Go file server
3. Cloud Integration: mint tokens for workflow runs
Each guide: overview, prerequisites, step-by-step, code examples, troubleshooting.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-guides', {
    agent: 'doc-writer',
    dependsOn: ['design-guides'],
    task: `Write all three integration guides.

Outline:
{{steps.design-guides.output}}

Architecture:
{{steps.read-architecture.output}}

SDK:
{{steps.read-sdk-middleware.output}}

Write three files:
1. ${ROOT}/docs/guides/relaycast-integration.md
2. ${ROOT}/docs/guides/relayfile-integration.md
3. ${ROOT}/docs/guides/cloud-integration.md
Each guide: overview, install SDK, configure middleware, verify tokens, check scopes, example code.
Keep each guide under 150 lines.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-guides', {
    type: 'deterministic',
    dependsOn: ['write-guides'],
    command: `test -f ${ROOT}/docs/guides/relaycast-integration.md && echo "relaycast OK" || echo "relaycast MISSING"; test -f ${ROOT}/docs/guides/relayfile-integration.md && echo "relayfile OK" || echo "relayfile MISSING"; test -f ${ROOT}/docs/guides/cloud-integration.md && echo "cloud OK" || echo "cloud MISSING"`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['verify-guides'],
    task: `Review all three integration guides.

Read all files in ${ROOT}/docs/guides/. Check:
1. Code examples are correct and runnable
2. Prerequisites listed clearly
3. Step-by-step is logical and complete
4. Scope examples match actual relayauth scope format
5. Consistent formatting across all three guides
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Finalize the integration guides.

Reviewer feedback:
{{steps.review.output}}

Read each issue from the reviewer feedback above. For each one:
1. Open the file mentioned
2. Make the specific fix described
3. Save the file

After all fixes, verify by reading the file again to confirm changes were applied.

Update files in ${ROOT}/docs/guides/.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n099 Integration Guides: ${result.status}`);
}

main().catch(console.error);
