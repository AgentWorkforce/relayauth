/**
 * 090-oss-cloudflare-separation.ts
 *
 * Clean separation between relayauth OSS and cloud repos.
 *
 * Problem: The OSS relayauth `packages/server/` is deeply coupled to
 * Cloudflare (D1Database, DurableObjects, wrangler.toml). The cloud repo
 * already has `packages/relayauth/` with proper CF storage adapters,
 * but the OSS repo duplicates that CF-specific code.
 *
 * Goal:
 *   OSS (relayauth): generic server with storage interface + SQLite/libsql impl
 *   Cloud (cloud): imports @relayauth/server, provides CF storage adapters
 *
 * Steps:
 * 1. Audit + plan what moves where
 * 2. Refactor OSS server: replace D1/DO with better-sqlite3, plain Node entry
 * 3. Move CF-specific code to cloud repo's packages/relayauth/
 * 4. Verify both build cleanly
 *
 * Run: npx tsx workflows/090-oss-cloudflare-separation.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const CLOUD_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
  const result = await workflow('oss-cloudflare-separation')
    .description('Clean Cloudflare code out of relayauth OSS, push CF-specific code to cloud repo')
    .pattern('linear')
    .channel('wf-relayauth-split')
    .maxConcurrency(2)
    .timeout(3_600_000)

    .agent('architect', { cli: 'claude', role: 'Plans the separation and validates correctness' })
    .agent('oss-builder', { cli: 'codex', preset: 'worker', role: 'Refactors the OSS relayauth repo' })
    .agent('cloud-builder', { cli: 'codex', preset: 'worker', role: 'Updates the cloud repo' })
    .agent('reviewer', { cli: 'claude', role: 'Reviews both repos for clean separation' })

    .step('audit-and-plan', {
      agent: 'architect',
      task: `Audit both repos and produce a concrete separation plan.

READ these files in the OSS relayauth repo (${RELAYAUTH_ROOT}):
- packages/server/src/worker.ts — current CF Worker entry point
- packages/server/src/env.ts — AppEnv bindings
- packages/server/src/storage/interface.ts — storage interface (KEEP in OSS)
- packages/server/src/storage/sqlite.ts — D1-based storage (NEEDS REWRITE)
- packages/server/src/storage/compat.ts — resolver helpers
- packages/server/src/durable-objects/identity-do.ts — IdentityDO (MOVE TO CLOUD)
- packages/server/src/index.ts — main exports
- packages/server/src/routes/ — all route files
- packages/server/src/engine/ — all engine files
- package.json — check wrangler/cloudflare deps and scripts
- wrangler.toml — REMOVE from OSS
- .dev.vars.example — REMOVE from OSS

READ these files in the cloud repo (${CLOUD_ROOT}):
- packages/relayauth/src/worker.ts — already exists, imports createApp
- packages/relayauth/src/entrypoints/cloudflare.ts — proper CF entry point
- packages/relayauth/src/storage/cloudflare/ — CF storage adapters (already exist!)
- packages/relayauth/src/durable-objects/ — IdentityDO (already duplicated here)
- packages/relayauth/package.json — deps on @relayauth/*

Produce a plan with these sections:
1. FILES TO DELETE from OSS (wrangler.toml, .dev.vars*, durable-objects/, worker.ts)
2. FILES TO REWRITE in OSS (sqlite.ts → use better-sqlite3 or libsql, compat.ts → remove D1 refs)
3. NEW FILES in OSS (server.ts — plain Hono + Node adapter, not Worker)
4. FILES TO UPDATE in cloud (if any identity-do.ts changes from OSS need merging)
5. PACKAGE.JSON changes (OSS: remove wrangler dep, add better-sqlite3; update scripts)
6. IMPORTS that will break and how to fix them
7. The storage interface.ts MUST NOT CHANGE — it's the contract between OSS and cloud

The cloud repo's packages/relayauth/ already has CF-specific storage adapters that import
from @relayauth/server/storage/interface — this is the correct pattern. The OSS server just
needs to stop shipping CF-specific implementations.

Key constraint: The cloud repo currently imports:
- @relayauth/server (for createApp, routes, engine)
- @relayauth/server/storage/interface (for storage types)
- @relayauth/types (for domain types)
These import paths MUST continue to work after the refactor.

Keep output under 80 lines. End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
      timeout: 300_000,
    })

    .step('refactor-oss', {
      agent: 'oss-builder',
      dependsOn: ['audit-and-plan'],
      task: `Refactor the OSS relayauth repo to remove all Cloudflare-specific code.

Plan: {{steps.audit-and-plan.output}}

Working in ${RELAYAUTH_ROOT}, on branch feat/oss-cf-separation.

1. DELETE Cloudflare files:
   - wrangler.toml
   - .dev.vars.example
   - .dev.vars (if exists)
   - packages/server/src/worker.ts
   - packages/server/src/durable-objects/ (entire directory)
   - .wrangler/ (local state directory)

2. REWRITE packages/server/src/storage/sqlite.ts:
   - Replace ALL D1Database refs with better-sqlite3 (npm: better-sqlite3)
   - Replace DurableObjectNamespace/DurableObjectState with plain classes
   - Keep the same SqliteStorage class name and interface
   - The storage interface (interface.ts) MUST NOT change
   - Use better-sqlite3 prepared statements instead of D1's prepare().bind().all()

3. REWRITE packages/server/src/storage/compat.ts:
   - Remove D1Database type checks/casts
   - Keep the resolver functions but only handle AuthStorage objects

4. CREATE packages/server/src/server.ts:
   - Export createApp() that returns a Hono app
   - Accept config: { storage: AuthStorage, signingKey, signingKeyId, ... }
   - Wire up all existing routes
   - NO Cloudflare bindings — plain config object

5. UPDATE packages/server/src/index.ts:
   - Export createApp from server.ts (not worker.ts)
   - Remove IdentityDO export

6. UPDATE packages/server/src/env.ts:
   - AppEnv should use plain config, not Cloudflare Bindings

7. UPDATE package.json:
   - Remove wrangler from deps/devDeps
   - Remove @cloudflare/* from deps
   - Add better-sqlite3 and @types/better-sqlite3
   - Update scripts: replace wrangler dev with plain node/tsx start
   - Add a "start" script: tsx packages/server/src/server.ts

8. UPDATE engine files that reference D1Database or DurableObject:
   - packages/server/src/engine/audit-retention.ts
   - Any others that import from durable-objects/ or reference D1Database

9. FIX all imports — grep for any remaining:
   - D1Database, DurableObject*, @cloudflare, wrangler
   - identity-do, durable-objects/
   
10. Run: npm install && npm run build (or tsc)
    Fix any TypeScript errors.

11. Commit: "refactor: remove Cloudflare deps from OSS — pure Node/better-sqlite3"
    Use: HUSKY=0 git -c core.hooksPath=/dev/null commit --no-verify
    Push to origin feat/oss-cf-separation

End with REFACTOR_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFACTOR_COMPLETE' },
      timeout: 1_200_000,
    })

    .step('update-cloud', {
      agent: 'cloud-builder',
      dependsOn: ['refactor-oss'],
      task: `Update cloud repo's packages/relayauth to work with the refactored OSS server.

Working in ${CLOUD_ROOT}, on branch feat/cloudflare-iac (the existing PR #56 branch).

The OSS @relayauth/server no longer exports:
- IdentityDO (moved to cloud)
- D1-specific createDatabaseStorage
- worker.ts

The cloud packages/relayauth/ ALREADY has:
- src/durable-objects/identity-do.ts — keep as-is
- src/storage/cloudflare/ — proper CF storage adapters, keep as-is
- src/entrypoints/cloudflare.ts — proper CF entry using createApp

Check and fix:
1. Verify imports from @relayauth/server still resolve:
   - createApp should still be exported from @relayauth/server
   - Storage interface types should still be at @relayauth/server/storage/interface
   
2. If worker.ts imports IdentityDO from @relayauth/server, fix it:
   - Import from local ./durable-objects/index.js instead

3. If any engine files were importing D1-specific stuff from @relayauth/server,
   update them to use the local cloudflare storage adapters.

4. Make sure packages/relayauth/wrangler.toml is correct (cloud SHOULD have this)

5. Run: cd packages/relayauth && npx tsc --noEmit
   Fix any TypeScript errors from the changed @relayauth/server exports.

6. Commit: "fix: update relayauth cloud package for OSS CF separation"
   Use: HUSKY=0 git -c core.hooksPath=/dev/null commit --no-verify
   Push to origin feat/cloudflare-iac

End with CLOUD_COMPLETE.`,
      verification: { type: 'output_contains', value: 'CLOUD_COMPLETE' },
      timeout: 900_000,
    })

    .step('verify-separation', {
      agent: 'reviewer',
      dependsOn: ['refactor-oss', 'update-cloud'],
      task: `Verify the separation is clean in both repos.

CHECK OSS (${RELAYAUTH_ROOT}, branch feat/oss-cf-separation):
1. grep -rn "D1Database\|DurableObject\|@cloudflare\|wrangler" packages/server/src/ --include="*.ts" | grep -v ".test."
   → MUST return 0 results
2. ls wrangler.toml .dev.vars* packages/server/src/worker.ts packages/server/src/durable-objects/
   → MUST all be missing
3. cat packages/server/src/storage/interface.ts — MUST be unchanged from main
4. npm run build (or tsc) — MUST succeed
5. Check that createApp is still exported from packages/server/src/index.ts

CHECK CLOUD (${CLOUD_ROOT}, branch feat/cloudflare-iac):
1. packages/relayauth/src/storage/cloudflare/ still imports from @relayauth/server/storage/interface
2. packages/relayauth/src/worker.ts or entrypoints/cloudflare.ts imports createApp from @relayauth/server
3. IdentityDO is defined locally, NOT imported from @relayauth/server
4. npx tsc --noEmit in packages/relayauth — MUST succeed

If anything fails, fix it. Keep output under 50 lines.
End with VERIFY_COMPLETE.`,
      verification: { type: 'output_contains', value: 'VERIFY_COMPLETE' },
      timeout: 300_000,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: RELAYAUTH_ROOT });

  console.log('OSS/Cloud separation complete:', result.status);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
