/**
 * 116-sqlite-adapter-parity.ts
 *
 * Make the SQLite storage adapter pass ALL existing tests that previously
 * used the Cloudflare adapter. 121 tests currently fail because the SQLite
 * adapter doesn't match the Cloudflare adapter's behavior in:
 * - Audit logging (queries, filtering, pagination, export)
 * - Identity lifecycle (budget tracking, auto-suspend, sponsor chains)
 * - Role/policy CRUD (org/workspace scoping)
 * - Token revocation (TTL-based expiry)
 *
 * The test-helpers.ts uses createSqliteStorage(":memory:") — all tests
 * must pass with SQLite, no Cloudflare mocks.
 *
 * Codex-only workers. Five parallel tracks by domain.
 *
 * Run: agent-relay run workflows/116-sqlite-adapter-parity.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const SERVER = RELAYAUTH + '/packages/server';

async function main() {
const result = await workflow('116-sqlite-adapter-parity')
  .description('Fix SQLite storage adapter to pass all 121 failing tests')
  .pattern('dag')
  .channel('wf-sqlite-parity')
  .maxConcurrency(5)
  .timeout(2_400_000)

  .agent('identity-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Fixes SQLite identity storage to match Cloudflare DO behavior',
    cwd: RELAYAUTH,
  })
  .agent('audit-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Fixes SQLite audit storage — logging, queries, filtering, pagination, export',
    cwd: RELAYAUTH,
  })
  .agent('rbac-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Fixes SQLite role and policy storage — CRUD, org/workspace scoping',
    cwd: RELAYAUTH,
  })
  .agent('revocation-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Fixes SQLite token revocation and webhook storage',
    cwd: RELAYAUTH,
  })
  .agent('helpers-worker', {
    cli: 'codex',
    preset: 'worker',
    role: 'Fixes test-helpers.ts and any test files that reference Cloudflare directly',
    cwd: RELAYAUTH,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-sqlite-adapter', {
    type: 'deterministic',
    command: `cat ${SERVER}/src/storage/sqlite.ts`,
    captureOutput: true,
  })

  .step('read-storage-interface', {
    type: 'deterministic',
    command: `cat ${SERVER}/src/storage/interface.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${SERVER}/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-failing-tests', {
    type: 'deterministic',
    command: `cd ${SERVER} && node --test --import tsx src/__tests__/*.test.ts 2>&1 | grep "not ok" | head -40`,
    captureOutput: true,
    failOnError: false,
  })

  .step('read-identity-tests', {
    type: 'deterministic',
    command: `head -80 ${SERVER}/src/__tests__/identity-do.test.ts 2>/dev/null && echo "=== CREATE IDENTITY ===" && head -60 ${SERVER}/src/__tests__/create-identity.test.ts 2>/dev/null`,
    captureOutput: true,
  })

  .step('read-audit-tests', {
    type: 'deterministic',
    command: `head -60 ${SERVER}/src/__tests__/audit-export-api.test.ts 2>/dev/null && echo "=== AUDIT QUERY ===" && head -60 ${SERVER}/src/__tests__/audit-query-api.test.ts 2>/dev/null`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Five codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('fix-identity-storage', {
    agent: 'identity-worker',
    dependsOn: ['read-sqlite-adapter', 'read-storage-interface', 'read-identity-tests', 'read-failing-tests'],
    task: `Fix SQLite identity storage to pass all identity-related tests.

SQLITE ADAPTER:
{{steps.read-sqlite-adapter.output}}

STORAGE INTERFACE:
{{steps.read-storage-interface.output}}

IDENTITY TESTS:
{{steps.read-identity-tests.output}}

FAILING TESTS:
{{steps.read-failing-tests.output}}

Edit ${SERVER}/src/storage/sqlite.ts — the identity storage section.

The SQLite identity storage must match the Cloudflare IdentityDO behavior:

1. create() must:
   - Generate id if not provided
   - Store sponsor_id and sponsor_chain
   - Initialize budget and budget_usage if provided
   - Auto-suspend if budget exceeded and autoSuspend=true
   - Write audit event on budget suspension
   - Return the full StoredIdentity

2. get() must return null for non-existent, full object for existing

3. update() must:
   - Deep merge metadata (not replace)
   - Preserve sponsor chain if not in patch
   - Re-evaluate budget after update
   - Update the updated_at timestamp

4. suspend() must set status='suspended', suspendedAt, suspendReason
5. retire() must set status='retired', clear suspend fields
6. reactivate() must set status='active', clear suspend fields
7. list() must support org_id filter, cursor pagination, limit

8. The identity table schema must include ALL fields from StoredIdentity:
   id, name, type, orgId, workspaceId, status, scopes (JSON),
   roles (JSON), metadata (JSON), sponsorId, sponsorChain (JSON),
   budget (JSON), budgetUsage (JSON), createdAt, updatedAt,
   suspendedAt, suspendReason, lastActiveAt

Run the identity tests to verify:
  cd ${SERVER} && node --test --import tsx src/__tests__/identity-do.test.ts src/__tests__/create-identity.test.ts src/__tests__/update-identity.test.ts src/__tests__/suspend-identity.test.ts src/__tests__/retire-identity.test.ts

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-audit-storage', {
    agent: 'audit-worker',
    dependsOn: ['read-sqlite-adapter', 'read-storage-interface', 'read-audit-tests', 'read-failing-tests'],
    task: `Fix SQLite audit storage to pass all audit-related tests.

SQLITE ADAPTER:
{{steps.read-sqlite-adapter.output}}

STORAGE INTERFACE:
{{steps.read-storage-interface.output}}

AUDIT TESTS:
{{steps.read-audit-tests.output}}

FAILING TESTS:
{{steps.read-failing-tests.output}}

Edit ${SERVER}/src/storage/sqlite.ts — the audit storage section.

The SQLite audit storage must support:

1. log() — insert audit entry with ALL fields:
   id, action, identityId, orgId, workspaceId, plane, resource,
   result, metadata (JSON), ip, userAgent, timestamp

2. query() — filter by:
   - orgId (required)
   - identityId (optional)
   - action (optional)
   - workspaceId (optional)
   - plane (optional)
   - result (optional — "allowed" or "denied")
   - from/to timestamps (optional)
   - cursor + limit for pagination

3. export() — return all matching entries (up to 10000)
   Support format hints (JSON, CSV) — the route handles formatting,
   storage just returns the data

4. The audit_logs table must have:
   id TEXT PRIMARY KEY,
   action TEXT NOT NULL,
   identity_id TEXT,
   org_id TEXT NOT NULL,
   workspace_id TEXT,
   plane TEXT,
   resource TEXT,
   result TEXT,
   metadata_json TEXT,
   ip TEXT,
   user_agent TEXT,
   timestamp TEXT NOT NULL

5. Audit webhook storage:
   create/list/delete webhooks with id, url, orgId, events (JSON array)

Run audit tests:
  cd ${SERVER} && node --test --import tsx src/__tests__/audit-export-api.test.ts src/__tests__/audit-query.test.ts src/__tests__/audit-webhooks.test.ts

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-rbac-storage', {
    agent: 'rbac-worker',
    dependsOn: ['read-sqlite-adapter', 'read-storage-interface', 'read-failing-tests'],
    task: `Fix SQLite role and policy storage to pass all RBAC tests.

SQLITE ADAPTER:
{{steps.read-sqlite-adapter.output}}

STORAGE INTERFACE:
{{steps.read-storage-interface.output}}

FAILING TESTS:
{{steps.read-failing-tests.output}}

Edit ${SERVER}/src/storage/sqlite.ts — the role and policy storage sections.

Roles must support:
1. create() — insert with id, name, description, scopes (JSON), orgId, workspaceId, builtIn, createdAt
2. get() — select by id, return null if not found
3. list() — filter by orgId, optional workspaceId
4. update() — partial update, preserve unset fields
5. delete() — delete by id

Policies must support:
1. create() — insert with id, name, effect, scopes (JSON), conditions (JSON), priority, orgId, workspaceId, createdAt
2. get() — select by id
3. list() — filter by orgId, optional workspaceId
4. update() — partial update
5. delete() — delete by id

Run RBAC tests:
  cd ${SERVER} && node --test --import tsx src/__tests__/rbac.test.ts

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-revocation-storage', {
    agent: 'revocation-worker',
    dependsOn: ['read-sqlite-adapter', 'read-storage-interface', 'read-failing-tests'],
    task: `Fix SQLite token revocation storage.

SQLITE ADAPTER:
{{steps.read-sqlite-adapter.output}}

STORAGE INTERFACE:
{{steps.read-storage-interface.output}}

FAILING TESTS:
{{steps.read-failing-tests.output}}

Edit ${SERVER}/src/storage/sqlite.ts — revocation section.

Revocation must:
1. revoke(jti, expiresAt) — INSERT into revoked_tokens
2. isRevoked(jti) — SELECT EXISTS, return boolean
3. Clean up expired tokens periodically (optional — can be lazy on read)

The table: revoked_tokens (jti TEXT PRIMARY KEY, expires_at INTEGER)

Run related tests to verify.

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-test-helpers', {
    agent: 'helpers-worker',
    dependsOn: ['read-test-helpers', 'read-failing-tests'],
    task: `Fix test-helpers.ts to use only SQLite — remove ALL Cloudflare references.

TEST HELPERS:
{{steps.read-test-helpers.output}}

FAILING TESTS:
{{steps.read-failing-tests.output}}

Edit ${SERVER}/src/__tests__/test-helpers.ts:

1. Remove: import { createCloudflareStorage } from "../storage/index.js"
2. Remove: the hasCustomCloudflareBindings branch
3. Always use: createSqliteStorage(":memory:")
4. Remove D1Database, KVNamespace, DurableObjectNamespace types
5. Remove mockD1(), mockKV(), mockDO() functions if they exist
6. The TestBindings type should only have:
   SIGNING_KEY, SIGNING_KEY_ID, INTERNAL_SECRET
   (No D1, KV, DO bindings)

7. createTestApp() becomes simply:
   const storage = createSqliteStorage(":memory:");
   const app = createApp({ storage, defaultBindings: { SIGNING_KEY: "dev-secret", ... } });

8. Also check ALL test files for direct Cloudflare imports:
   grep -r "createCloudflareStorage\\|D1Database\\|KVNamespace\\|DurableObject" src/__tests__/
   Fix any that reference Cloudflare — they should use the storage interface.

Run ALL tests after fixing:
  cd ${SERVER} && node --test --import tsx src/__tests__/*.test.ts

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['fix-identity-storage', 'fix-audit-storage', 'fix-rbac-storage', 'fix-revocation-storage', 'fix-test-helpers'],
    command: `cd ${SERVER} && echo "=== BUILD ===" && npx turbo build --filter=@relayauth/server --force 2>&1 | tail -5 && echo "=== TESTS ===" && node --test --import tsx src/__tests__/*.test.ts 2>&1 | tail -10`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-remaining', {
    agent: 'helpers-worker',
    dependsOn: ['verify'],
    task: `Fix any remaining test failures.

VERIFY:
{{steps.verify.output}}

If tests still fail, read the specific error messages and fix the
SQLite adapter or test expectations.

Common issues:
- JSON fields not being parsed/stringified correctly
- Timestamps in wrong format (ISO string vs unix)
- Missing table columns
- Pagination cursor format mismatch
- Assert deep equal failing on field order

Run: cd ${SERVER} && node --test --import tsx src/__tests__/*.test.ts

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYAUTH,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n116 SQLite Adapter Parity: ${result.status}`);
}

main().catch(console.error);
