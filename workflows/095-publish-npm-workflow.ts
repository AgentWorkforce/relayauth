/**
 * 095-publish-npm-workflow.ts
 *
 * Domain 11: Testing & CI
 * GitHub Actions: npm publish with provenance for types + sdk
 *
 * Depends on: 094
 * Run: agent-relay run workflows/095-publish-npm-workflow.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('095-publish-npm-workflow')
  .description('GitHub Actions: npm publish with provenance for types + sdk')
  .pattern('dag')
  .channel('wf-relayauth-095')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design publish pipeline, fix issues',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write GitHub Actions publish workflow YAML',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review publish workflow for security and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read ───────────────────────────────────────────────

  .step('read-relaycast-publish', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/.github/workflows/publish.yml 2>/dev/null || cat ${RELAYCAST}/.github/workflows/release.yml 2>/dev/null || echo "No relaycast publish workflow found"`,
    captureOutput: true,
  })

  .step('read-types-pkg', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/package.json`,
    captureOutput: true,
  })

  .step('read-sdk-pkg', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/package.json`,
    captureOutput: true,
  })

  .step('read-ci-workflow', {
    type: 'deterministic',
    command: `cat ${ROOT}/.github/workflows/ci.yml`,
    captureOutput: true,
  })

  // ── Phase 2: Write ──────────────────────────────────────────────

  .step('write-publish', {
    agent: 'implementer',
    dependsOn: ['read-relaycast-publish', 'read-types-pkg', 'read-sdk-pkg', 'read-ci-workflow'],
    task: `Write the GitHub Actions publish workflow.

Relaycast publish reference:
{{steps.read-relaycast-publish.output}}

Types package.json:
{{steps.read-types-pkg.output}}

SDK package.json:
{{steps.read-sdk-pkg.output}}

CI workflow:
{{steps.read-ci-workflow.output}}

Write to ${ROOT}/.github/workflows/publish.yml:
- Trigger on: release published (GitHub releases)
- Permissions: contents read, id-token write (for provenance)
- Jobs: build → publish-types → publish-sdk (sequential)
- Each publish job: npm ci, turbo build, npm publish --provenance
- Use NPM_TOKEN secret for auth
- Only publish @relayauth/types and @relayauth/sdk (not server/cli)
- Add check that version in package.json matches release tag`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-publish'],
    command: `test -f ${ROOT}/.github/workflows/publish.yml && echo "publish.yml OK" || echo "publish.yml MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Review + Fix ───────────────────────────────────────

  .step('validate-yaml', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node -e "const fs=require('fs'); const y=require('yaml'); try { y.parse(fs.readFileSync('.github/workflows/publish.yml','utf8')); console.log('YAML valid'); } catch(e) { console.log('YAML error:', e.message); }" 2>&1; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['validate-yaml'],
    task: `Review the publish workflow.

YAML validation:
{{steps.validate-yaml.output}}

Read ${ROOT}/.github/workflows/publish.yml. Check:
1. Provenance enabled (id-token: write permission)
2. NPM_TOKEN used correctly as secret
3. Version tag check before publish
4. Types published before SDK (dependency order)
5. No accidental publish of server/cli packages
6. No hardcoded secrets or tokens
List issues to fix.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix all issues from the review.

Reviewer feedback:
{{steps.review.output}}

YAML validation:
{{steps.validate-yaml.output}}

Fix all issues in ${ROOT}/.github/workflows/publish.yml.
Ensure the YAML is valid.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n095 Publish NPM Workflow: ${result.status}`);
}

main().catch(console.error);
