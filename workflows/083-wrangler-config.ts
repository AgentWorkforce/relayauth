/**
 * 083-wrangler-config.ts
 *
 * Domain 10: Hosted Server
 * Complete wrangler.toml: DO, KV, D1, environments
 *
 * Depends on: 001
 * Run: agent-relay run workflows/083-wrangler-config.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('083-wrangler-config')
  .description('Complete wrangler.toml with DO, KV, D1, and environment configs')
  .pattern('dag')
  .channel('wf-relayauth-083')
  .maxConcurrency(4)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design wrangler.toml structure, fix issues after review',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write wrangler.toml and environment configs',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review wrangler config for completeness and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read references ──────────────────────────────────────

  .step('read-relaycast-wrangler', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/wrangler.toml`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  // ── Phase 2: Design + Implement ───────────────────────────────────

  .step('design-config', {
    agent: 'architect',
    dependsOn: ['read-relaycast-wrangler', 'read-env', 'read-architecture'],
    task: `Design the wrangler.toml for relayauth-cloud.

Relaycast wrangler.toml (reference pattern):
{{steps.read-relaycast-wrangler.output}}

Server env types:
{{steps.read-env.output}}

Architecture:
{{steps.read-architecture.output}}

Write a plan to ${ROOT}/docs/083-wrangler-plan.md covering:
1. Worker name: relayauth-api
2. D1 database binding: DB (for identities, roles, policies, audit, api_keys)
3. KV namespace binding: REVOCATION_KV (for token revocation list)
4. Durable Objects: IdentityDO (per-agent state)
5. Environments: production, staging (preview)
6. Secrets: SIGNING_KEY, SIGNING_KEY_ID, INTERNAL_SECRET
7. Migrations for DO (new_sqlite_classes)
8. Compatibility flags: nodejs_compat`,
    verification: { type: 'exit_code' },
  })

  .step('write-wrangler', {
    agent: 'implementer',
    dependsOn: ['design-config'],
    task: `Write the complete wrangler.toml for relayauth.

Plan:
{{steps.design-config.output}}

Relaycast reference:
{{steps.read-relaycast-wrangler.output}}

Write ${ROOT}/wrangler.toml with:
- name = "relayauth-api"
- main = "packages/server/src/worker.ts"
- compatibility_date = "2024-12-01"
- compatibility_flags = ["nodejs_compat"]
- D1: binding DB, database_name "relayauth", migrations_dir
- KV: binding REVOCATION_KV
- DO: IdentityDO with SQLite migration
- [env.staging] overrides (staging DB, KV)
- Secrets comment block at bottom
- Match relaycast's structure closely`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-wrangler'],
    command: `test -f ${ROOT}/wrangler.toml && echo "wrangler.toml OK" || echo "wrangler.toml MISSING"; grep -c "IdentityDO" ${ROOT}/wrangler.toml 2>/dev/null || echo "NO IdentityDO"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Review + Fix ─────────────────────────────────────────

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['verify-files'],
    task: `Review the wrangler.toml config.

File check:
{{steps.verify-files.output}}

Read ${ROOT}/wrangler.toml and check:
1. All bindings match env.ts types (DB, REVOCATION_KV, IDENTITY_DO)
2. DO migration tags are correct
3. Staging environment has all overrides
4. Secrets are documented (not hardcoded)
5. Matches relaycast patterns
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix issues from the review.

Reviewer feedback:
{{steps.review.output}}

Fix all issues in ${ROOT}/wrangler.toml.
Verify with: cat ${ROOT}/wrangler.toml`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n083 Wrangler Config: ${result.status}`);
}

main().catch(console.error);
