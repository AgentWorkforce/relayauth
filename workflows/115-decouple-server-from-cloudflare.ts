/**
 * 115-decouple-server-from-cloudflare.ts
 *
 * Decouple the relayauth server from Cloudflare bindings so it can
 * run on any runtime (Node.js locally, Cloudflare Workers in cloud).
 *
 * The key change: introduce a storage abstraction layer. Routes and
 * business logic call the interface. The runtime provides the adapter.
 *
 * Local:  SQLite adapter (better-sqlite3, zero config)
 * Cloud:  D1 + KV + Durable Objects adapter (existing code, moved behind interface)
 *
 * After this, `agent-relay on codex` runs a plain Node.js server —
 * no wrangler, no Cloudflare, no D1.
 *
 * Codex-only workers. Six parallel tracks for the large refactor.
 *
 * Run: agent-relay run workflows/115-decouple-server-from-cloudflare.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('115-decouple-server-from-cloudflare')
  .description('Decouple relayauth server from Cloudflare — storage abstraction + SQLite adapter for local')
  .pattern('dag')
  .channel('wf-decouple-cf')
  .maxConcurrency(5)
  .timeout(2_400_000)

  .agent('interface-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Defines the storage abstraction interfaces',
    cwd: RELAYAUTH,
  })
  .agent('sqlite-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implements SQLite storage adapter for local development',
    cwd: RELAYAUTH,
  })
  .agent('cloudflare-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Extracts existing D1/KV/DO code into the Cloudflare storage adapter',
    cwd: RELAYAUTH,
  })
  .agent('routes-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Refactors routes to use storage interface instead of direct D1/KV calls',
    cwd: RELAYAUTH,
  })
  .agent('entrypoint-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Creates Node.js and Cloudflare entry points with runtime detection',
    cwd: RELAYAUTH,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Updates tests to use the storage interface and SQLite adapter',
    cwd: RELAYAUTH,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-identity-do', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/durable-objects/identity-do.ts`,
    captureOutput: true,
  })

  .step('read-routes-identities', {
    type: 'deterministic',
    command: `head -100 ${RELAYAUTH}/packages/server/src/routes/identities.ts`,
    captureOutput: true,
  })

  .step('read-audit-logger', {
    type: 'deterministic',
    command: `head -80 ${RELAYAUTH}/packages/server/src/engine/audit-logger.ts`,
    captureOutput: true,
  })

  .step('read-scope-middleware', {
    type: 'deterministic',
    command: `head -60 ${RELAYAUTH}/packages/server/src/middleware/scope.ts`,
    captureOutput: true,
  })

  .step('read-engine-files', {
    type: 'deterministic',
    command: `ls ${RELAYAUTH}/packages/server/src/engine/ && echo "---" && head -30 ${RELAYAUTH}/packages/server/src/engine/roles.ts && echo "---" && head -30 ${RELAYAUTH}/packages/server/src/engine/policies.ts`,
    captureOutput: true,
  })

  .step('read-db-migrations', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/server/src/db/migrations/0001_local_bootstrap.sql 2>/dev/null || ls ${RELAYAUTH}/packages/server/src/db/ 2>/dev/null || echo "NO DB DIR"`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Six codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-storage-interface', {
    agent: 'interface-worker',
    dependsOn: ['read-identity-do', 'read-routes-identities', 'read-audit-logger', 'read-engine-files'],
    task: `Define the storage abstraction interfaces.

IDENTITY DO (current storage):
{{steps.read-identity-do.output}}

ROUTES (how storage is used):
{{steps.read-routes-identities.output}}

AUDIT LOGGER:
{{steps.read-audit-logger.output}}

ENGINE FILES:
{{steps.read-engine-files.output}}

Create ${RELAYAUTH}/packages/server/src/storage/interface.ts:

This defines ALL storage operations the server needs. Every route and
engine module calls these interfaces instead of D1/KV/DO directly.

import type {
  AgentIdentity, IdentityStatus, IdentityType,
  Role, Policy, AuditEntry, AuditQuery,
} from '@relayauth/types';

// ── Identity Storage ─────────────────────────────────────────

export interface IdentityStorage {
  create(input: CreateIdentityInput): Promise<StoredIdentity>;
  get(id: string): Promise<StoredIdentity | null>;
  update(id: string, patch: Partial<StoredIdentity>): Promise<StoredIdentity>;
  list(orgId: string, opts?: { limit?: number; cursor?: string }): Promise<{
    items: StoredIdentity[];
    cursor?: string;
  }>;
  suspend(id: string, reason: string): Promise<StoredIdentity>;
  retire(id: string): Promise<StoredIdentity>;
  reactivate(id: string): Promise<StoredIdentity>;
  delete(id: string): Promise<void>;
}

export interface StoredIdentity extends AgentIdentity {
  sponsorId: string;
  sponsorChain: string[];
  workspaceId: string;
  budget?: IdentityBudget;
  budgetUsage?: IdentityBudgetUsage;
}

export interface CreateIdentityInput {
  id: string;
  name: string;
  type: IdentityType;
  orgId: string;
  workspaceId: string;
  sponsorId: string;
  sponsorChain: string[];
  scopes: string[];
  roles: string[];
  metadata: Record<string, string>;
}

export interface IdentityBudget {
  maxActionsPerHour?: number;
  maxCostPerDay?: number;
  alertThreshold?: number;
  autoSuspend?: boolean;
}

export interface IdentityBudgetUsage {
  actionsThisHour: number;
  costToday: number;
  lastResetAt: string;
}

// ── Token Revocation ─────────────────────────────────────────

export interface RevocationStorage {
  revoke(jti: string, expiresAt: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

// ── Role Storage ─────────────────────────────────────────────

export interface RoleStorage {
  create(role: Role): Promise<Role>;
  get(id: string): Promise<Role | null>;
  update(id: string, patch: Partial<Role>): Promise<Role>;
  delete(id: string): Promise<void>;
  list(orgId: string, opts?: { workspaceId?: string }): Promise<Role[]>;
}

// ── Policy Storage ───────────────────────────────────────────

export interface PolicyStorage {
  create(policy: Policy): Promise<Policy>;
  get(id: string): Promise<Policy | null>;
  update(id: string, patch: Partial<Policy>): Promise<Policy>;
  delete(id: string): Promise<void>;
  list(orgId: string, opts?: { workspaceId?: string }): Promise<Policy[]>;
}

// ── Audit Storage ────────────────────────────────────────────

export interface AuditStorage {
  log(entry: Omit<AuditEntry, 'id'>): Promise<void>;
  query(query: AuditQuery): Promise<{ items: AuditEntry[]; cursor?: string }>;
  export(orgId: string, opts: { from?: string; to?: string }): Promise<AuditEntry[]>;
}

// ── Audit Webhook Storage ────────────────────────────────────

export interface AuditWebhookStorage {
  create(webhook: { url: string; orgId: string; events: string[] }): Promise<{ id: string }>;
  list(orgId: string): Promise<Array<{ id: string; url: string; events: string[] }>>;
  delete(id: string): Promise<void>;
}

// ── Combined Storage ─────────────────────────────────────────

export interface AuthStorage {
  identities: IdentityStorage;
  revocation: RevocationStorage;
  roles: RoleStorage;
  policies: PolicyStorage;
  audit: AuditStorage;
  auditWebhooks: AuditWebhookStorage;
}

Also create ${RELAYAUTH}/packages/server/src/storage/index.ts:
  export * from './interface.js';

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-sqlite-adapter', {
    agent: 'sqlite-worker',
    dependsOn: ['read-identity-do', 'read-db-migrations'],
    task: `Implement SQLite storage adapter for local development.

IDENTITY DO (reference for schema):
{{steps.read-identity-do.output}}

DB MIGRATIONS (schema):
{{steps.read-db-migrations.output}}

Create ${RELAYAUTH}/packages/server/src/storage/sqlite.ts:

Uses better-sqlite3 for zero-config local storage.

import Database from 'better-sqlite3';
import type { AuthStorage, IdentityStorage, RevocationStorage, ... } from './interface.js';

export function createSqliteStorage(dbPath?: string): AuthStorage {
  // dbPath defaults to .relay/relayauth.db (auto-created)
  const db = new Database(dbPath ?? '.relay/relayauth.db');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Auto-create tables on first use
  db.exec(\`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      org_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      org_id TEXT NOT NULL,
      workspace_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      org_id TEXT NOT NULL,
      workspace_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      identity_id TEXT,
      org_id TEXT NOT NULL,
      result TEXT,
      metadata_json TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      org_id TEXT NOT NULL,
      events TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_identities_org ON identities(org_id);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_revoked_expires ON revoked_tokens(expires_at);
  \`);

  return {
    identities: new SqliteIdentityStorage(db),
    revocation: new SqliteRevocationStorage(db),
    roles: new SqliteRoleStorage(db),
    policies: new SqlitePolicyStorage(db),
    audit: new SqliteAuditStorage(db),
    auditWebhooks: new SqliteAuditWebhookStorage(db),
  };
}

Implement each class. Store complex objects as JSON in a 'data' column
(same pattern as the Durable Object's identity_records table).

For identities: INSERT/SELECT/UPDATE on the identities table.
  create() → INSERT, return parsed data
  get(id) → SELECT WHERE id, parse JSON
  update(id, patch) → read, merge, UPDATE
  list(orgId) → SELECT WHERE org_id, parse each
  suspend/retire/reactivate → update status field

For revocation: simple key lookup.
  revoke(jti) → INSERT
  isRevoked(jti) → SELECT EXISTS

For roles/policies: same INSERT/SELECT/UPDATE/DELETE pattern.
For audit: INSERT for log, SELECT with filters for query.

Add better-sqlite3 as an OPTIONAL dependency (peer dep or dynamic import):
  try { Database = require('better-sqlite3'); } catch { ... }
  If not available, fall back to in-memory Map-based storage.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-cloudflare-adapter', {
    agent: 'cloudflare-worker',
    dependsOn: ['read-identity-do', 'read-env', 'read-audit-logger'],
    task: `Extract existing D1/KV/DO code into a Cloudflare storage adapter.

IDENTITY DO:
{{steps.read-identity-do.output}}

ENV (bindings):
{{steps.read-env.output}}

AUDIT LOGGER:
{{steps.read-audit-logger.output}}

Create ${RELAYAUTH}/packages/server/src/storage/cloudflare.ts:

This wraps the existing Cloudflare-specific code behind the AuthStorage
interface. NO new logic — just move existing D1/KV/DO calls behind the
interface methods.

import type { AuthStorage, IdentityStorage, ... } from './interface.js';

interface CloudflareBindings {
  DB: D1Database;
  REVOCATION_KV: KVNamespace;
  IDENTITY_DO: DurableObjectNamespace;
  SIGNING_KEY: string;
  SIGNING_KEY_ID: string;
  INTERNAL_SECRET: string;
}

export function createCloudflareStorage(bindings: CloudflareBindings): AuthStorage {
  return {
    identities: new CloudflareIdentityStorage(bindings),
    revocation: new CloudflareRevocationStorage(bindings.REVOCATION_KV),
    roles: new CloudflareRoleStorage(bindings.DB),
    policies: new CloudflarePolicyStorage(bindings.DB),
    audit: new CloudflareAuditStorage(bindings.DB),
    auditWebhooks: new CloudflareAuditWebhookStorage(bindings.DB),
  };
}

CloudflareIdentityStorage:
  Uses the IDENTITY_DO Durable Object stub (existing pattern):
  - get(id): fetch DO by id, GET /internal/get
  - create(input): fetch DO, POST /internal/create
  - update(id, patch): fetch DO, PATCH /internal/update
  - suspend/retire/reactivate: fetch DO, POST /internal/suspend etc.
  (This is exactly what identities.ts route does now — extract the DO
  fetch calls into this adapter)

CloudflareRevocationStorage:
  Uses KV namespace (existing pattern):
  - revoke(jti): KV.put(jti, "1", { expiration })
  - isRevoked(jti): KV.get(jti) !== null

CloudflareRoleStorage / PolicyStorage:
  Uses D1 (existing engine/roles.ts and engine/policies.ts queries):
  - Move the D1 prepare/bind/run calls here

CloudflareAuditStorage:
  Uses D1 (existing engine/audit-logger.ts queries):
  - Move the audit INSERT and SELECT queries here

IdentityDO class stays as-is — it's the Durable Object implementation
that Cloudflare runs. The adapter just calls it via fetch.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-route-refactor', {
    agent: 'routes-worker',
    dependsOn: ['read-routes-identities', 'read-worker', 'read-scope-middleware'],
    task: `Refactor routes to use storage interface instead of direct D1/KV/DO calls.

ROUTES (identities):
{{steps.read-routes-identities.output}}

WORKER:
{{steps.read-worker.output}}

SCOPE MIDDLEWARE:
{{steps.read-scope-middleware.output}}

The routes currently access Cloudflare bindings directly:
  c.env.DB.prepare(...)
  c.env.IDENTITY_DO.get(...)
  c.env.REVOCATION_KV.get(...)

Refactor to access storage from the Hono context:

1. Add storage to the app context. In the createApp factory:

  export function createApp(storage: AuthStorage): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // Inject storage into context
    app.use('*', async (c, next) => {
      c.set('storage', storage);
      await next();
    });

    // ... existing middleware and routes ...
    return app;
  }

2. Update AppEnv type in env.ts:

  export type AppEnv = {
    Bindings: {
      SIGNING_KEY: string;
      SIGNING_KEY_ID: string;
      INTERNAL_SECRET: string;
      // Remove D1/KV/DO bindings — they're in the storage adapter
    };
    Variables: {
      requestId: string;
      storage: AuthStorage;
    };
  };

3. In each route file, replace direct binding access with storage:

  Before:
    const stub = c.env.IDENTITY_DO.get(c.env.IDENTITY_DO.idFromName(id));
    const resp = await stub.fetch(new Request('http://do/internal/get'));

  After:
    const storage = c.get('storage');
    const identity = await storage.identities.get(id);

  Before:
    const result = await c.env.DB.prepare('SELECT ...').bind(...).all();

  After:
    const roles = await storage.roles.list(orgId);

4. Do this for ALL route files:
   - routes/identities.ts
   - routes/roles.ts
   - routes/policies.ts
   - routes/role-assignments.ts
   - routes/identity-activity.ts
   - routes/audit-query.ts
   - routes/audit-export.ts
   - routes/audit-webhooks.ts
   - routes/dashboard-stats.ts

5. Do this for ALL engine files:
   - engine/audit-logger.ts
   - engine/roles.ts
   - engine/policies.ts
   - engine/policy-evaluation.ts
   - engine/scope-inheritance.ts
   - engine/audit-webhook-dispatcher.ts

Keep SIGNING_KEY, SIGNING_KEY_ID, INTERNAL_SECRET as direct bindings
(they're config, not storage).

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-entrypoints', {
    agent: 'entrypoint-worker',
    dependsOn: ['read-worker', 'read-env'],
    task: `Create Node.js and Cloudflare entry points with runtime detection.

WORKER:
{{steps.read-worker.output}}

ENV:
{{steps.read-env.output}}

Create TWO entry points:

1. ${RELAYAUTH}/packages/server/src/entrypoints/node.ts:

For local development (agent-relay on):

import { createApp } from '../worker.js';
import { createSqliteStorage } from '../storage/sqlite.js';
import { serve } from '@hono/node-server';

export function startLocalServer(opts: {
  port?: number;
  signingKey?: string;
  dbPath?: string;
}) {
  const storage = createSqliteStorage(opts.dbPath);
  const app = createApp(storage);

  // Inject signing key into env (Hono context)
  app.use('*', async (c, next) => {
    c.env.SIGNING_KEY = opts.signingKey ?? 'dev-secret';
    c.env.SIGNING_KEY_ID = 'dev-key';
    c.env.INTERNAL_SECRET = 'internal-dev-secret';
    await next();
  });

  const port = opts.port ?? 8787;
  console.log('relayauth listening on :' + port);
  return serve({ fetch: app.fetch, port });
}

// CLI entry point
if (process.argv[1]?.endsWith('node.js') || process.argv[1]?.endsWith('node.ts')) {
  startLocalServer({
    port: parseInt(process.env.PORT ?? '8787'),
    signingKey: process.env.SIGNING_KEY ?? 'dev-secret',
  });
}

2. ${RELAYAUTH}/packages/server/src/entrypoints/cloudflare.ts:

For Cloudflare Workers deployment:

import { createApp } from '../worker.js';
import { createCloudflareStorage } from '../storage/cloudflare.js';
export { IdentityDO } from '../durable-objects/index.js';

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    const storage = createCloudflareStorage(env);
    const app = createApp(storage);

    // Set env bindings for signing key etc.
    // Hono handles this via the env parameter
    return app.fetch(request, env, ctx);
  },
};

3. Update package.json exports:

{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/entrypoints/node.d.ts",
      "import": "./dist/entrypoints/node.js"
    },
    "./cloudflare": {
      "types": "./dist/entrypoints/cloudflare.d.ts",
      "import": "./dist/entrypoints/cloudflare.js"
    }
  }
}

4. Add @hono/node-server as a dependency (for the Node entry point).

5. Add better-sqlite3 as an optional peer dependency.

Now agent-relay on uses:
  import { startLocalServer } from '@relayauth/server/node';
  startLocalServer({ port: 8787, signingKey: secret });

And cloud uses:
  import cloudflareHandler from '@relayauth/server/cloudflare';
  export default cloudflareHandler;

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-tests', {
    agent: 'test-worker',
    dependsOn: ['read-identity-do', 'read-routes-identities'],
    task: `Update tests to use the storage interface and SQLite adapter.

IDENTITY DO:
{{steps.read-identity-do.output}}

ROUTES:
{{steps.read-routes-identities.output}}

1. Create ${RELAYAUTH}/packages/server/src/__tests__/storage-sqlite.test.ts:

Test the SQLite adapter directly:

- TestSqliteIdentityCRUD: create, get, update, list, delete
- TestSqliteIdentitySuspendRetire: suspend, reactivate, retire
- TestSqliteRevocation: revoke, isRevoked
- TestSqliteRoleCRUD: create, get, list, update, delete
- TestSqlitePolicyCRUD: same
- TestSqliteAuditLog: log entry, query by org, query by time range
- TestSqliteAutoCreateTables: fresh DB creates all tables

Use a temp directory for the SQLite file. Clean up after each test.

2. Update ${RELAYAUTH}/packages/server/src/__tests__/test-helpers.ts:

The existing test helpers mock D1/KV/DO. Update them to use SQLite:

  export function createTestApp() {
    const storage = createSqliteStorage(':memory:'); // in-memory SQLite
    const app = createApp(storage);
    return { app, storage };
  }

This makes tests run without any Cloudflare mocks — just real SQLite.

3. Verify existing tests still pass with the new storage interface.
   The route tests should work unchanged if test-helpers provides
   the correct createTestApp().

Use node:test.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: [
      'impl-storage-interface', 'impl-sqlite-adapter', 'impl-cloudflare-adapter',
      'impl-route-refactor', 'impl-entrypoints', 'impl-tests',
    ],
    command: `cd ${RELAYAUTH} && echo "=== STORAGE FILES ===" && ls packages/server/src/storage/*.ts 2>/dev/null && echo "=== ENTRYPOINTS ===" && ls packages/server/src/entrypoints/*.ts 2>/dev/null && echo "=== createApp accepts storage ===" && grep -c "createApp.*storage\|AuthStorage" packages/server/src/worker.ts && echo "=== NO DIRECT D1 IN ROUTES ===" && grep -c "c\.env\.DB\|c\.env\.IDENTITY_DO\|c\.env\.REVOCATION_KV" packages/server/src/routes/*.ts 2>/dev/null | awk -F: '{sum+=$2}END{print sum " direct binding refs remaining"}' && echo "=== BUILD ===" && npx turbo build --filter=@relayauth/server 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'routes-worker',
    dependsOn: ['verify'],
    task: `Fix any build failures.

VERIFY:
{{steps.verify.output}}

If direct D1/KV/DO references remain in routes, replace them with
storage interface calls. If build fails, fix TypeScript errors.

cd ${RELAYAUTH} && npx turbo build --filter=@relayauth/server

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYAUTH,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n115 Decouple Server from Cloudflare: ${result.status}`);
}

main().catch(console.error);
