/**
 * 114-publish-server-package.ts
 *
 * Extract @relayauth/server as a publishable npm package so cloud
 * can import it instead of copying 25 source files.
 *
 * The server package exports:
 * - createApp() — Hono app factory with all routes + middleware
 * - IdentityDO — Durable Object class
 * - AppEnv type — Cloudflare Worker bindings
 *
 * Cloud wraps it with billing/multi-tenant middleware.
 * OSS runs it directly via wrangler dev.
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/114-publish-server-package.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('114-publish-server-package')
  .description('Extract @relayauth/server as publishable npm package for cloud to import')
  .pattern('dag')
  .channel('wf-server-pkg')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('package-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Restructures packages/server for npm publishing with createApp factory export',
    cwd: RELAYAUTH,
  })
  .agent('exports-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Creates the public API surface: createApp, IdentityDO, AppEnv, route factories',
    cwd: RELAYAUTH,
  })
  .agent('publish-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Updates publish workflow and package.json for @relayauth/server',
    cwd: RELAYAUTH,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Writes tests verifying the package exports and app factory work',
    cwd: RELAYAUTH,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-worker-ts', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-server-pkg', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/package.json`,
    captureOutput: true,
  })

  .step('read-server-structure', {
    type: 'deterministic',
    command: `find ${RELAYAUTH}/packages/server/src -name "*.ts" -not -path "*__tests__*" | sort`,
    captureOutput: true,
  })

  .step('read-env-ts', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-publish-yml', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/.github/workflows/publish.yml`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Four codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-package-restructure', {
    agent: 'package-worker',
    dependsOn: ['read-server-pkg', 'read-server-structure'],
    task: `Restructure packages/server for npm publishing.

CURRENT PACKAGE.JSON:
{{steps.read-server-pkg.output}}

SERVER FILES:
{{steps.read-server-structure.output}}

Edit ${RELAYAUTH}/packages/server/package.json:

Currently the server package is "private: true" and named "relayauth-server".
Change it to be publishable:

{
  "name": "@relayauth/server",
  "version": "0.1.2",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "dev": "wrangler dev",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "node --test --import tsx src/__tests__/*.test.ts"
  },
  "dependencies": {
    "hono": "^4",
    "@relayauth/core": "workspace:*",
    "@relayauth/types": "workspace:*"
  },
  "peerDependencies": {
    "@cloudflare/workers-types": "^4"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4",
    "wrangler": "^4"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}

Remove "private": true.
The package depends on @relayauth/core (for scope matching, token verify)
and @relayauth/types (for type definitions).

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-exports', {
    agent: 'exports-worker',
    dependsOn: ['read-worker-ts', 'read-env-ts', 'read-server-structure'],
    task: `Create the public API surface for @relayauth/server.

CURRENT WORKER.TS:
{{steps.read-worker-ts.output}}

ENV.TS:
{{steps.read-env-ts.output}}

SERVER FILES:
{{steps.read-server-structure.output}}

The current worker.ts creates a Hono app inline. Refactor to export
a factory function that cloud can wrap.

1. Edit ${RELAYAUTH}/packages/server/src/worker.ts:

Keep the existing code but wrap the app creation in a factory:

import { Hono } from "hono";
import type { AppEnv } from "./env.js";
// ... existing route imports ...

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Move ALL existing middleware and route registration here
  // (CORS, request ID, auth middleware, rate limiting, routes)

  return app;
}

// Default export for direct wrangler dev usage (OSS)
const app = createApp();
export default app;

// Re-export Durable Object for wrangler
export { IdentityDO } from "./durable-objects/index.js";

2. Create ${RELAYAUTH}/packages/server/src/index.ts:

The barrel export for the npm package:

// App factory — cloud wraps this with custom middleware
export { createApp } from "./worker.js";

// Durable Object — cloud re-exports for wrangler
export { IdentityDO } from "./durable-objects/index.js";

// Types — cloud uses these for bindings
export type { AppEnv } from "./env.js";

// Individual route factories (for cloud to cherry-pick if needed)
export { default as identityRoutes } from "./routes/identities.js";
export { default as roleRoutes } from "./routes/roles.js";
export { default as policyRoutes } from "./routes/policies.js";
export { default as discoveryRoutes } from "./routes/discovery.js";
export { default as jwksRoutes } from "./routes/jwks.js";
export { default as auditQueryRoutes } from "./routes/audit-query.js";
export { default as auditExportRoutes } from "./routes/audit-export.js";
export { default as auditWebhookRoutes } from "./routes/audit-webhooks.js";
export { default as dashboardStatsRoutes } from "./routes/dashboard-stats.js";
export { default as roleAssignmentRoutes } from "./routes/role-assignments.js";
export { default as identityActivityRoutes } from "./routes/identity-activity.js";

// Middleware exports (for cloud to compose custom stacks)
export { requireScope, requireScopes, requireAnyScope } from "./middleware/scope.js";

3. Update tsconfig.json to output to dist/:
Ensure "outDir": "dist" and "declaration": true are set.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-publish-config', {
    agent: 'publish-worker',
    dependsOn: ['read-publish-yml'],
    task: `Update the publish workflow to include @relayauth/server.

CURRENT PUBLISH.YML:
{{steps.read-publish-yml.output}}

Edit ${RELAYAUTH}/.github/workflows/publish.yml:

1. Add "server" to the package choices:
   options:
     - all
     - core
     - sdk
     - types
     - server    # NEW

2. Update the "all" case to include server:
   if [ "$INPUT" = "all" ]; then
     echo "list=types,core,sdk,server" >> "$GITHUB_OUTPUT"
     echo 'matrix=["types","core","sdk","server"]' >> "$GITHUB_OUTPUT"

3. Server should be published AFTER core and types (it depends on them).
   The max-parallel: 1 in the publish job handles ordering since it
   goes through the matrix sequentially.

4. Also update turbo.json if needed to include the server package in
   the build pipeline.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-tests', {
    agent: 'test-worker',
    dependsOn: ['read-worker-ts', 'read-server-structure'],
    task: `Write tests verifying the package exports and app factory.

Create ${RELAYAUTH}/packages/server/src/__tests__/exports.test.ts:

Tests:

1. TestCreateAppReturnsHonoApp
   - import { createApp } from '../worker.js'
   - const app = createApp()
   - Verify app is a Hono instance
   - Verify app.routes includes /health

2. TestCreateAppHasAllRoutes
   - const app = createApp()
   - Verify routes exist: /health, /v1/identities, /v1/roles,
     /v1/policies, /.well-known/agent-configuration, /.well-known/jwks.json

3. TestIndexExportsAll
   - import * as server from '../index.js'
   - Verify: server.createApp is a function
   - Verify: server.IdentityDO is a class
   - Verify: server.requireScope is a function

4. TestAppFactoryIsIdempotent
   - const app1 = createApp()
   - const app2 = createApp()
   - Verify they are different instances (not shared state)

Use node:test.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-package-restructure', 'impl-exports', 'impl-publish-config', 'impl-tests'],
    command: `cd ${RELAYAUTH} && echo "=== PACKAGE.JSON ===" && node -e "const p=require('./packages/server/package.json');console.log(p.name,p.version,p.private??'not-private')" && echo "=== INDEX.TS ===" && test -f packages/server/src/index.ts && echo "EXISTS" || echo "MISSING" && echo "=== createApp ===" && grep -c "export.*createApp" packages/server/src/worker.ts && echo "=== BUILD ===" && npx turbo build --filter=@relayauth/server 2>&1 | tail -10; echo "BUILD: $?" && echo "=== PUBLISH YML ===" && grep -c "server" .github/workflows/publish.yml`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'exports-worker',
    dependsOn: ['verify'],
    task: `Fix any build failures.

VERIFY:
{{steps.verify.output}}

Fix TypeScript errors. Then:
  cd ${RELAYAUTH} && npx turbo build --filter=@relayauth/server

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYAUTH,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n114 Publish Server Package: ${result.status}`);
}

main().catch(console.error);
