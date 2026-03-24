/**
 * 096-deploy-workflow.ts
 *
 * Domain 11: Testing & CI
 * GitHub Actions: wrangler deploy on push to main
 *
 * Depends on: 094
 * Run: agent-relay run workflows/096-deploy-workflow.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('096-deploy-workflow')
  .description('GitHub Actions: wrangler deploy on push to main')
  .pattern('dag')
  .channel('wf-relayauth-096')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design deploy pipeline, fix issues',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write GitHub Actions deploy workflow YAML',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review deploy workflow for safety and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read ───────────────────────────────────────────────

  .step('read-relaycast-deploy', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/.github/workflows/deploy.yml 2>/dev/null || echo "No relaycast deploy workflow found"`,
    captureOutput: true,
  })

  .step('read-wrangler', {
    type: 'deterministic',
    command: `cat ${ROOT}/wrangler.toml`,
    captureOutput: true,
  })

  .step('read-ci-workflow', {
    type: 'deterministic',
    command: `cat ${ROOT}/.github/workflows/ci.yml`,
    captureOutput: true,
  })

  // ── Phase 2: Write ──────────────────────────────────────────────

  .step('write-deploy', {
    agent: 'implementer',
    dependsOn: ['read-relaycast-deploy', 'read-wrangler', 'read-ci-workflow'],
    task: `Write the GitHub Actions deploy workflow.

Relaycast deploy reference:
{{steps.read-relaycast-deploy.output}}

Wrangler config:
{{steps.read-wrangler.output}}

CI workflow:
{{steps.read-ci-workflow.output}}

Write to ${ROOT}/.github/workflows/deploy.yml:
- Trigger on: push to main (after CI passes)
- Environment: production (with GitHub environment protection)
- Jobs: test → deploy-staging → e2e-staging → deploy-production
- Test job: npm ci, turbo typecheck, turbo test
- Staging: wrangler deploy --env staging, run D1 migrations
- E2E: npx tsx scripts/e2e.ts against staging URL
- Production: wrangler deploy --env production, run D1 migrations
- Use CLOUDFLARE_API_TOKEN secret
- Add concurrency group (only one deploy at a time)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-deploy'],
    command: `test -f ${ROOT}/.github/workflows/deploy.yml && echo "deploy.yml OK" || echo "deploy.yml MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Review + Fix ───────────────────────────────────────

  .step('validate-yaml', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node -e "const fs=require('fs'); const y=require('yaml'); try { y.parse(fs.readFileSync('.github/workflows/deploy.yml','utf8')); console.log('YAML valid'); } catch(e) { console.log('YAML error:', e.message); }" 2>&1; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['validate-yaml'],
    task: `Review the deploy workflow.

YAML validation:
{{steps.validate-yaml.output}}

Read ${ROOT}/.github/workflows/deploy.yml. Check:
1. Deploy only after tests pass
2. Staging before production
3. E2E validation against staging
4. D1 migrations run before deploy
5. Concurrency group prevents parallel deploys
6. CLOUDFLARE_API_TOKEN used as secret (not hardcoded)
7. GitHub environment protection for production
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

Fix all issues in ${ROOT}/.github/workflows/deploy.yml.
Ensure the YAML is valid.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n096 Deploy Workflow: ${result.status}`);
}

main().catch(console.error);
