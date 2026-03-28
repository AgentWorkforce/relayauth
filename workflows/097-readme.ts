/**
 * 097-readme.ts
 *
 * Domain 12: Docs & Landing
 * Comprehensive README: quick start, architecture, API overview
 *
 * Depends on: all
 * Run: agent-relay run workflows/097-readme.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('097-readme')
  .description('Comprehensive README: quick start, architecture, API overview')
  .pattern('dag')
  .channel('wf-relayauth-097')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design README structure, finalize after review',
    cwd: ROOT,
  })
  .agent('doc-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the README document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review README for completeness, accuracy, and clarity',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-openapi', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/openapi.yaml 2>/dev/null || cat ${ROOT}/specs/openapi.md 2>/dev/null || echo "No OpenAPI spec"`,
    captureOutput: true,
  })

  .step('read-sdk-index', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/index.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-readme', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/README.md 2>/dev/null || echo "No relaycast README"`,
    captureOutput: true,
  })

  .step('design-readme', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-openapi', 'read-sdk-index', 'read-relaycast-readme'],
    task: `Design the README structure for relayauth.

Architecture:
{{steps.read-architecture.output}}

SDK exports:
{{steps.read-sdk-index.output}}

Relaycast README (for style reference):
{{steps.read-relaycast-readme.output}}

Write an outline to ${ROOT}/docs/097-readme-outline.md with sections:
1. Hero: what relayauth is (agent-native auth for the Relay ecosystem)
2. Quick Start: install SDK, verify token, check scopes (5 lines)
3. Architecture: diagram (mermaid), packages overview
4. API Overview: key endpoints grouped by domain
5. SDK Usage: TypeScript, Go, Python examples
6. CLI: key commands
7. Self-hosting: wrangler deploy
8. Contributing, License`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-readme', {
    agent: 'doc-writer',
    dependsOn: ['design-readme'],
    task: `Write the full README.

Outline:
{{steps.design-readme.output}}

Architecture:
{{steps.read-architecture.output}}

SDK exports:
{{steps.read-sdk-index.output}}

Write to ${ROOT}/README.md following the outline exactly.
Use concise, developer-friendly language. Include code examples.
Add mermaid architecture diagram. Keep under 300 lines.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-readme', {
    type: 'deterministic',
    dependsOn: ['write-readme'],
    command: `test -f ${ROOT}/README.md && wc -l ${ROOT}/README.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['verify-readme'],
    task: `Review the README.

Read ${ROOT}/README.md. Check:
1. Quick start is copy-pasteable and works
2. Architecture diagram is accurate
3. API overview covers all domains
4. Code examples are correct TypeScript
5. No broken links or placeholder text
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Finalize the README.

Reviewer feedback:
{{steps.review.output}}

Read each issue from the reviewer feedback above. For each one:
1. Open the file mentioned
2. Make the specific fix described
3. Save the file

After all fixes, verify by reading the file again to confirm changes were applied.

Update ${ROOT}/README.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n097 README: ${result.status}`);
}

main().catch(console.error);
