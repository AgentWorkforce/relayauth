/**
 * 088-deploy-staging.ts
 *
 * Domain 10: Hosted Server
 * Deploy to staging: wrangler deploy --env staging
 *
 * Depends on: 083, 084, 085, 086, 087
 * Run: agent-relay run workflows/088-deploy-staging.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('088-deploy-staging')
  .description('Deploy relayauth to staging with wrangler deploy --env staging')
  .pattern('dag')
  .channel('wf-relayauth-088')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design deploy pipeline, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write deploy validation tests and scripts',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write deploy scripts and pre-deploy checks',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review deploy pipeline for safety and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ──────────────────────────────────────────

  .step('read-wrangler', {
    type: 'deterministic',
    command: `cat ${ROOT}/wrangler.toml`,
    captureOutput: true,
  })

  .step('read-relaycast-deploy', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/.github/workflows/deploy.yml 2>/dev/null || echo "NO DEPLOY WORKFLOW"`,
    captureOutput: true,
  })

  .step('read-migrations', {
    type: 'deterministic',
    command: `ls ${ROOT}/packages/server/src/db/migrations/ 2>/dev/null`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-wrangler', 'read-migrations'],
    task: `Write deploy validation tests.

Wrangler config:
{{steps.read-wrangler.output}}

Migrations:
{{steps.read-migrations.output}}

Write ${ROOT}/packages/server/src/__tests__/deploy-staging.test.ts:
- Test wrangler.toml has staging env config
- Test all migration files exist
- Test migration files are numbered sequentially
- Test wrangler.toml bindings match env.ts
- Test deploy script exists and is executable
Use node:test + node:assert/strict.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/deploy-staging.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ────────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-wrangler', 'read-relaycast-deploy'],
    task: `Write staging deploy scripts.

Wrangler config:
{{steps.read-wrangler.output}}

Relaycast deploy pattern:
{{steps.read-relaycast-deploy.output}}

Write ${ROOT}/scripts/deploy-staging.sh:
#!/bin/bash
set -euo pipefail
echo "=== Pre-deploy checks ==="
npx turbo build
npx turbo typecheck
echo "=== Running D1 migrations (staging) ==="
npx wrangler d1 migrations apply relayauth-staging --env staging
echo "=== Deploying to staging ==="
npx wrangler deploy --env staging
echo "=== Post-deploy health check ==="
curl -sf https://relayauth-staging.{domain}/health || exit 1
echo "=== Staging deploy complete ==="

Also write ${ROOT}/scripts/pre-deploy-check.sh:
- Verify all env vars are set
- Verify wrangler is authenticated
- Verify D1 database exists
- Run tests before deploy
Make both executable (chmod +x).`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/scripts/deploy-staging.sh && echo "deploy script OK" || echo "deploy script MISSING"; test -f ${ROOT}/scripts/pre-deploy-check.sh && echo "pre-deploy OK" || echo "pre-deploy MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/deploy-staging.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review staging deploy pipeline.

Test results:
{{steps.run-tests.output}}

Typecheck:
{{steps.typecheck.output}}

Read deploy scripts and check:
1. Pre-deploy checks are comprehensive
2. Migrations run before deploy
3. Health check verifies deployment
4. Rollback strategy exists (or is documented)
5. No secrets in scripts
List issues.`,
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

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/deploy-staging.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n088 Deploy Staging: ${result.status}`);
}

main().catch(console.error);
