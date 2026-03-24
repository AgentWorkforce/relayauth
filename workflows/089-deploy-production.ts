/**
 * 089-deploy-production.ts
 *
 * Domain 10: Hosted Server
 * Deploy to production with migration safety checks
 *
 * Depends on: 088
 * Run: agent-relay run workflows/089-deploy-production.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('089-deploy-production')
  .description('Deploy to production with migration safety checks')
  .pattern('dag')
  .channel('wf-relayauth-089')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design production deploy safety, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write production deploy validation tests',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write production deploy scripts with safety checks',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review production deploy for safety, rollback, and migration guards',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ──────────────────────────────────────────

  .step('read-staging-deploy', {
    type: 'deterministic',
    command: `cat ${ROOT}/scripts/deploy-staging.sh`,
    captureOutput: true,
  })

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

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-staging-deploy', 'read-wrangler'],
    task: `Write production deploy validation tests.

Staging deploy script:
{{steps.read-staging-deploy.output}}

Wrangler config:
{{steps.read-wrangler.output}}

Write ${ROOT}/packages/server/src/__tests__/deploy-production.test.ts:
- Test production deploy script exists
- Test migration safety checks are present
- Test rollback script exists
- Test production env vars checklist is complete
- Test deploy requires staging success first
Use node:test + node:assert/strict.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/deploy-production.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ────────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-staging-deploy', 'read-wrangler', 'read-relaycast-deploy'],
    task: `Write production deploy scripts.

Staging deploy:
{{steps.read-staging-deploy.output}}

Wrangler config:
{{steps.read-wrangler.output}}

Relaycast deploy:
{{steps.read-relaycast-deploy.output}}

Write ${ROOT}/scripts/deploy-production.sh:
#!/bin/bash
set -euo pipefail
echo "=== Production Deploy ==="
echo "=== Step 1: Pre-flight checks ==="
bash scripts/pre-deploy-check.sh
echo "=== Step 2: Verify staging is healthy ==="
curl -sf https://relayauth-staging.{domain}/health || { echo "Staging unhealthy"; exit 1; }
echo "=== Step 3: Migration safety check ==="
npx wrangler d1 migrations list relayauth --env production
echo "=== Step 4: Apply migrations ==="
npx wrangler d1 migrations apply relayauth --env production
echo "=== Step 5: Deploy ==="
npx wrangler deploy
echo "=== Step 6: Health check ==="
curl -sf https://api.relayauth.dev/health || { echo "DEPLOY FAILED"; exit 1; }
echo "=== Production deploy complete ==="

Write ${ROOT}/scripts/rollback-production.sh:
- Rollback to previous version using wrangler rollback
- Verify health after rollback
Make both executable.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/scripts/deploy-production.sh && echo "deploy OK" || echo "deploy MISSING"; test -f ${ROOT}/scripts/rollback-production.sh && echo "rollback OK" || echo "rollback MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ────────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/deploy-production.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review production deploy pipeline.

Test results:
{{steps.run-tests.output}}

Typecheck:
{{steps.typecheck.output}}

Read deploy and rollback scripts. Check:
1. Pre-flight checks are comprehensive
2. Staging health verified before production deploy
3. Migration safety (no destructive migrations without confirmation)
4. Rollback script is complete and tested
5. Health check verifies all endpoints
6. No secrets in scripts
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/deploy-production.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n089 Deploy Production: ${result.status}`);
}

main().catch(console.error);
