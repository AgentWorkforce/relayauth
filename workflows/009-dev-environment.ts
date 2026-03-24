/**
 * 009-dev-environment.ts
 *
 * Domain 1: Foundation
 * Local dev: wrangler dev, seed data, dev tokens
 *
 * Depends on: 001
 * Run: agent-relay run workflows/009-dev-environment.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('009-dev-environment')
  .description('Local dev: wrangler dev, seed data, dev tokens')
  .pattern('dag')
  .channel('wf-relayauth-009')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design dev environment setup, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for dev environment scripts',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement dev environment scripts and config',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review dev environment for completeness and usability',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-existing-scripts', {
    type: 'deterministic',
    command: `ls -la ${ROOT}/scripts/ 2>/dev/null; cat ${ROOT}/scripts/generate-dev-token.sh 2>/dev/null || echo "not found"`,
    captureOutput: true,
  })

  .step('read-wrangler', {
    type: 'deterministic',
    command: `cat ${ROOT}/wrangler.toml 2>/dev/null || echo "not found"`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-dev', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/wrangler.toml 2>/dev/null | head -50; echo "=== SEED ===" && ls ${RELAYCAST}/scripts/ 2>/dev/null`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-existing-scripts', 'read-env'],
    task: `Write tests for dev environment utilities.

Existing scripts:
{{steps.read-existing-scripts.output}}

Env bindings:
{{steps.read-env.output}}

Write to ${ROOT}/packages/server/src/__tests__/dev-environment.test.ts.
Use node:test + node:assert/strict. Test:
- Seed data script creates valid test identities
- Dev token generator produces valid JWT structure
- Wrangler config has required bindings (D1, KV, DO)
- .dev.vars template has all required env vars`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/dev-environment.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-wrangler', 'read-env', 'read-relaycast-dev'],
    task: `Implement the dev environment setup.

Existing wrangler:
{{steps.read-wrangler.output}}

Env bindings:
{{steps.read-env.output}}

Relaycast reference:
{{steps.read-relaycast-dev.output}}

Create these files:

1. ${ROOT}/wrangler.toml — CF Workers config with:
   - name: relayauth-server
   - compatibility_date, main: packages/server/src/worker.ts
   - D1 database binding (RELAYAUTH_DB)
   - KV namespace binding (REVOCATION_KV)
   - Durable Object binding (IDENTITY_DO)
   - [env.dev] and [env.staging] sections

2. ${ROOT}/.dev.vars.example — template for local secrets:
   SIGNING_KEY, SIGNING_KEY_ID, INTERNAL_SECRET

3. ${ROOT}/scripts/seed-dev-data.ts — seed script that:
   - Creates test org, workspace, identities via D1
   - Prints created IDs

4. ${ROOT}/scripts/generate-dev-token.sh — update existing or create:
   - Signs JWT with HS256 + dev-secret
   - Includes test claims (sub, org, wks, scopes, exp)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/wrangler.toml && echo "wrangler OK" || echo "wrangler MISSING"; test -f ${ROOT}/.dev.vars.example && echo "dev.vars OK" || echo "dev.vars MISSING"; test -f ${ROOT}/scripts/seed-dev-data.ts && echo "seed OK" || echo "seed MISSING"; test -f ${ROOT}/scripts/generate-dev-token.sh && echo "token OK" || echo "token MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/dev-environment.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the dev environment setup.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation. Check:
1. wrangler.toml has all bindings from env.ts
2. .dev.vars.example has all required secrets
3. Seed script creates realistic test data
4. Dev token script produces valid JWT
5. Consistent with relaycast dev setup patterns
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

Typecheck results:
{{steps.typecheck.output}}

Fix all issues. Then run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/dev-environment.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n009 Dev Environment: ${result.status}`);
}

main().catch(console.error);
