/**
 * 094-ci-workflow.ts
 *
 * Domain 11: Testing & CI
 * GitHub Actions CI: test, typecheck, build on every PR
 *
 * Depends on: 091, 092
 * Run: agent-relay run workflows/094-ci-workflow.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('094-ci-workflow')
  .description('GitHub Actions CI: test, typecheck, build on every PR')
  .pattern('dag')
  .channel('wf-relayauth-094')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design CI pipeline, fix issues',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write GitHub Actions workflow YAML',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review CI workflow for correctness and best practices',
    cwd: ROOT,
  })

  // ── Phase 1: Read ───────────────────────────────────────────────

  .step('read-relaycast-ci', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/.github/workflows/ci.yml 2>/dev/null || echo "No relaycast CI found"`,
    captureOutput: true,
  })

  .step('read-package-json', {
    type: 'deterministic',
    command: `cat ${ROOT}/package.json`,
    captureOutput: true,
  })

  .step('read-turbo-json', {
    type: 'deterministic',
    command: `cat ${ROOT}/turbo.json`,
    captureOutput: true,
  })

  // ── Phase 2: Write ──────────────────────────────────────────────

  .step('write-ci', {
    agent: 'implementer',
    dependsOn: ['read-relaycast-ci', 'read-package-json', 'read-turbo-json'],
    task: `Write the GitHub Actions CI workflow.

Relaycast CI reference:
{{steps.read-relaycast-ci.output}}

Package.json:
{{steps.read-package-json.output}}

Turbo config:
{{steps.read-turbo-json.output}}

Write to ${ROOT}/.github/workflows/ci.yml:
- Trigger on: push to main, pull_request
- Jobs: install, typecheck, test, build (use turbo)
- Node 20, npm ci, turbo cache
- Run: npm run typecheck, npm test, npm run build
- Use matrix if multiple packages need separate test runs
- Add concurrency group to cancel stale PR runs`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-ci'],
    command: `test -f ${ROOT}/.github/workflows/ci.yml && echo "ci.yml OK" || echo "ci.yml MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Review + Fix ───────────────────────────────────────

  .step('validate-yaml', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node -e "const fs=require('fs'); const y=require('yaml'); try { y.parse(fs.readFileSync('.github/workflows/ci.yml','utf8')); console.log('YAML valid'); } catch(e) { console.log('YAML error:', e.message); }" 2>&1; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['validate-yaml'],
    task: `Review the CI workflow.

YAML validation:
{{steps.validate-yaml.output}}

Read ${ROOT}/.github/workflows/ci.yml. Check:
1. Correct trigger events (push main + PR)
2. Node 20, npm ci, turbo cache
3. All three jobs: typecheck, test, build
4. Concurrency group for PR runs
5. No security issues (no secret exposure)
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

Fix all issues in ${ROOT}/.github/workflows/ci.yml.
Ensure the YAML is valid.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n094 CI Workflow: ${result.status}`);
}

main().catch(console.error);
