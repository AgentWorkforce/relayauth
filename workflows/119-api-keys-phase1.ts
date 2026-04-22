/**
 * 119-api-keys-phase1.ts
 *
 * spec: specs/api-keys-and-rs256-migration.md (Phase 1)
 * depends on: 118 (POST /v1/tokens must exist before API keys have anywhere
 *             useful to authenticate to)
 *
 * Implements the api-keys surface across both repos:
 *   - relayauth (this repo): /v1/api-keys POST/GET/revoke routes,
 *     ApiKeyStorage interface, x-api-key middleware, accept-either auth
 *     on identities + tokens routes, lib/api-keys.ts (hashing + key gen).
 *   - cloud (sibling repo): D1 migration 0002_api_keys.sql, Cloudflare
 *     adapter for ApiKeyStorage, wire into createCloudflareStorage.
 *
 * Same review model as 118: implementer self-review → security + spec
 * peer reviewers (parallel) → architect synthesis → fix → re-review →
 * approval gate.
 *
 * Run: agent-relay run workflows/119-api-keys-phase1.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
  const result = await workflow('119-api-keys-phase1')
    .description('Implement /v1/api-keys + x-api-key middleware in relayauth and cloud, with strict review')
    .pattern('dag')
    .channel('wf-relayauth-119')
    .maxConcurrency(4)
    .timeout(2_700_000)

    .agent('architect', {
      cli: 'claude',
      preset: 'lead',
      role: 'Lead the cross-repo implementation, synthesize reviews, drive fixes',
      cwd: RELAYAUTH,
    })
    .agent('relayauth-impl', {
      cli: 'codex',
      preset: 'worker',
      role: 'Write tests + implementation in @relayauth/server',
      cwd: RELAYAUTH,
    })
    .agent('cloud-impl', {
      cli: 'codex',
      preset: 'worker',
      role: 'Write D1 migration + Cloudflare ApiKeyStorage adapter in cloud',
      cwd: CLOUD,
    })
    .agent('security-reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'API-key handling: hashing, generation entropy, leakage, revocation, audit',
      cwd: RELAYAUTH,
    })
    .agent('spec-reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'OpenAPI conformance, error catalog, response shapes, contract test alignment',
      cwd: RELAYAUTH,
    })

    // ── Phase A: Read context ──────────────────────────────────────────

    .step('read-migration-spec', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/specs/api-keys-and-rs256-migration.md`,
      captureOutput: true,
    })

    .step('read-openapi', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/specs/openapi.yaml`,
      captureOutput: true,
    })

    .step('read-contract-test', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/packages/server/src/__tests__/e2e/contract.test.ts`,
      captureOutput: true,
    })

    .step('read-storage-interfaces', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/packages/server/src/storage/interface.ts`,
      captureOutput: true,
    })

    .step('read-existing-auth-lib', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/packages/server/src/lib/auth.ts`,
      captureOutput: true,
    })

    .step('read-cloud-storage', {
      type: 'deterministic',
      command: `cd ${CLOUD} && cat packages/relayauth/src/storage/cloudflare/index.ts && echo '--- identities adapter ---' && cat packages/relayauth/src/storage/cloudflare/identities.ts | head -80`,
      captureOutput: true,
    })

    .step('read-cloud-migrations', {
      type: 'deterministic',
      command: `cat ${CLOUD}/packages/relayauth/src/db/migrations/0001_local_bootstrap.sql`,
      captureOutput: true,
    })

    // ── Phase B: Tests first (relayauth side) ──────────────────────────

    .step('write-relayauth-tests', {
      agent: 'relayauth-impl',
      dependsOn: ['read-migration-spec', 'read-openapi', 'read-contract-test', 'read-storage-interfaces', 'read-existing-auth-lib'],
      task: `Write failing tests for the API-key surface in relayauth.

Migration spec (Phase 1 only):
{{steps.read-migration-spec.output}}

OpenAPI for /v1/api-keys:
{{steps.read-openapi.output}}

Contract test references (must satisfy these):
{{steps.read-contract-test.output}}

Storage interfaces (you'll add ApiKeyStorage here):
{{steps.read-storage-interfaces.output}}

Existing auth lib (you'll add authenticateBearerOrApiKey here):
{{steps.read-existing-auth-lib.output}}

Files to create:
- ${RELAYAUTH}/packages/server/src/__tests__/api-keys.test.ts (covers POST/GET/revoke + x-api-key middleware)
- ${RELAYAUTH}/packages/server/src/__tests__/auth-bearer-or-apikey.test.ts (covers the new helper)

Required test cases:
1. POST /v1/api-keys returns 201 with { apiKey: { id, name, prefix, scopes }, key: "rak_..." }
2. The returned key authenticates against POST /v1/identities via x-api-key header
3. Revoked key returns 401 on subsequent identity create
4. Plaintext key is never returned by GET /v1/api-keys (only prefix)
5. Hash isolation: changing one byte of the plaintext fails verification (use the same hash function the impl uses)
6. authenticateBearerOrApiKey accepts a valid bearer JWT and returns its claims
7. authenticateBearerOrApiKey accepts a valid x-api-key and returns synthesized claims with the api-key's scopes
8. Both auth methods missing returns 401
9. Both present and conflicting (e.g. revoked api-key + valid bearer): bearer wins (api-key check is short-circuited)
10. last_used_at is updated when an api-key authenticates (debounced — exact mechanism is impl's call)

Use node:test + node:assert/strict.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-relayauth-tests-exist', {
      type: 'deterministic',
      dependsOn: ['write-relayauth-tests'],
      command: `test -f ${RELAYAUTH}/packages/server/src/__tests__/api-keys.test.ts && test -f ${RELAYAUTH}/packages/server/src/__tests__/auth-bearer-or-apikey.test.ts && echo OK || (echo MISSING; exit 1)`,
      captureOutput: true,
    })

    // ── Phase C: Implement (relayauth + cloud in parallel) ─────────────

    .step('implement-relayauth', {
      agent: 'relayauth-impl',
      dependsOn: ['verify-relayauth-tests-exist'],
      task: `Implement the API-key surface in @relayauth/server so the tests pass.

Files to create / modify:
1. ${RELAYAUTH}/packages/server/src/storage/api-key-types.ts — StoredApiKey, CreateApiKeyInput, ListApiKeysOptions
2. ${RELAYAUTH}/packages/server/src/storage/interface.ts — add ApiKeyStorage interface; add to AuthStorage
3. ${RELAYAUTH}/packages/server/src/storage/sqlite.ts — implement ApiKeyStorage for SQLite
4. ${RELAYAUTH}/packages/server/src/lib/api-keys.ts — generateApiKey(), hashApiKey(), extractPrefix()
   - Key format: "rak_" + base64url(crypto.getRandomValues(32 bytes))
   - Hash: SHA-256 of plaintext, hex-encoded
   - Prefix: first 8 chars of plaintext (for UI display)
5. ${RELAYAUTH}/packages/server/src/lib/auth.ts — add authenticateBearerOrApiKey(req, signingKey, storage)
6. ${RELAYAUTH}/packages/server/src/middleware/api-key-auth.ts — Hono middleware factory
7. ${RELAYAUTH}/packages/server/src/routes/api-keys.ts — POST/GET/revoke
8. ${RELAYAUTH}/packages/server/src/server.ts — register new route

Constraints:
- Plaintext key returned exactly once (POST response). Never logged. Never returned by GET.
- Only the hash + prefix persisted.
- last_used_at update should be debounced (skip if updated within last 60s).
- Hashing must be constant-time-comparable on the lookup path.

Do NOT modify identities.ts or tokens.ts in this phase yet — the bearer-or-apikey
plumbing on those routes lands as a separate step (next).`,
      verification: { type: 'exit_code' },
    })

    .step('implement-cloud-adapter', {
      agent: 'cloud-impl',
      dependsOn: ['read-cloud-storage', 'read-cloud-migrations', 'verify-relayauth-tests-exist'],
      task: `Implement the Cloudflare D1 adapter for ApiKeyStorage in the cloud repo.

Existing cloud adapters for reference:
{{steps.read-cloud-storage.output}}

Existing migration (you'll add 0002 next to it):
{{steps.read-cloud-migrations.output}}

Files to create / modify:
1. ${CLOUD}/packages/relayauth/src/db/migrations/0002_api_keys.sql:
   CREATE TABLE IF NOT EXISTS api_keys (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     key_hash TEXT NOT NULL,
     key_prefix TEXT NOT NULL,
     scopes TEXT NOT NULL,
     org_id TEXT,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked_at INTEGER
   );
   CREATE INDEX api_keys_key_hash_idx ON api_keys(key_hash);
   CREATE INDEX api_keys_org_id_idx ON api_keys(org_id);

2. ${CLOUD}/packages/relayauth/src/storage/cloudflare/api-keys.ts:
   - Implements ApiKeyStorage interface from @relayauth/server (you'll bump the dep
     once 119-relayauth lands and is published)
   - Uses env.DB (D1 binding) for queries
   - Match the pattern of identities.ts in the same dir

3. ${CLOUD}/packages/relayauth/src/storage/cloudflare/index.ts:
   - Wire api-keys adapter into createCloudflareStorage's returned AuthStorage

Constraints:
- Migration is forward-only — no DROP, no ALTER. Add to top of migrations list, not in the middle.
- D1 doesn't support RETURNING in older runtimes — use SELECT after INSERT if needed.
- Match the existing identities.ts adapter's error-handling style (StorageError throws).`,
      verification: { type: 'exit_code' },
    })

    .step('verify-impl-files', {
      type: 'deterministic',
      dependsOn: ['implement-relayauth', 'implement-cloud-adapter'],
      command: `test -f ${RELAYAUTH}/packages/server/src/routes/api-keys.ts \
        && test -f ${RELAYAUTH}/packages/server/src/lib/api-keys.ts \
        && test -f ${RELAYAUTH}/packages/server/src/middleware/api-key-auth.ts \
        && test -f ${CLOUD}/packages/relayauth/src/db/migrations/0002_api_keys.sql \
        && test -f ${CLOUD}/packages/relayauth/src/storage/cloudflare/api-keys.ts \
        && grep -q 'app.route."/v1/api-keys"' ${RELAYAUTH}/packages/server/src/server.ts \
        && echo OK || (echo MISSING; exit 1)`,
      captureOutput: true,
    })

    // ── Phase D: Wire api-key auth onto identities + tokens routes ─────

    .step('wire-bearer-or-apikey', {
      agent: 'relayauth-impl',
      dependsOn: ['verify-impl-files'],
      task: `Update identities and tokens routes to accept either bearer or x-api-key auth.

Replace authenticateAndAuthorize calls in:
- ${RELAYAUTH}/packages/server/src/routes/identities.ts (POST /, all mutating routes)
- ${RELAYAUTH}/packages/server/src/routes/tokens.ts (POST /, /refresh, /revoke; introspect can stay bearer-only)

with the new authenticateBearerOrApiKey helper. Preserve scope-checking semantics
(api-keys' granted scopes must satisfy the route's required scope, same as bearer).

Add tests in ${RELAYAUTH}/packages/server/src/__tests__/identities-apikey-auth.test.ts:
1. POST /v1/identities with valid x-api-key succeeds
2. POST /v1/identities with x-api-key whose scopes don't satisfy required scope returns 403
3. POST /v1/identities with revoked x-api-key returns 401`,
      verification: { type: 'exit_code' },
    })

    // ── Phase E: Self-review + run tests ───────────────────────────────

    .step('self-review', {
      agent: 'relayauth-impl',
      dependsOn: ['wire-bearer-or-apikey'],
      task: `Self-review BEFORE peer reviewers. Read every file you changed:

relayauth-side:
- routes/api-keys.ts
- routes/identities.ts (modified)
- routes/tokens.ts (modified)
- lib/api-keys.ts
- lib/auth.ts (modified)
- middleware/api-key-auth.ts
- storage/api-key-types.ts
- storage/interface.ts (modified)
- storage/sqlite.ts (modified)
- server.ts (modified)
- __tests__/api-keys.test.ts
- __tests__/auth-bearer-or-apikey.test.ts
- __tests__/identities-apikey-auth.test.ts

cloud-side:
- packages/relayauth/src/db/migrations/0002_api_keys.sql
- packages/relayauth/src/storage/cloudflare/api-keys.ts
- packages/relayauth/src/storage/cloudflare/index.ts (modified)

Walk through:
1. Plaintext key path: created → returned in 201 response ONLY → never persisted, never logged, never returned again.
2. Hashing: SHA-256, hex-encoded, used for both insert and lookup, same canonicalisation on both sides.
3. Lookup performance: index exists on key_hash. Lookup is O(1) by hash.
4. Revocation: revoked_at set immediately, lookup checks revoked_at IS NULL.
5. last_used_at debounce: not on the hot path (don't update on every request — too much D1 write traffic).
6. Bearer-or-apikey precedence: documented and tested.
7. Migration: forward-only, idempotent on re-run.

List every issue P0/P1/P2 with proposed fix. Fix P0s now and re-list. End with "self-review clean" if no issues remain.`,
      verification: { type: 'exit_code' },
    })

    .step('run-relayauth-tests', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: `cd ${RELAYAUTH} && node --test --import tsx packages/server/src/__tests__/api-keys.test.ts packages/server/src/__tests__/auth-bearer-or-apikey.test.ts packages/server/src/__tests__/identities-apikey-auth.test.ts 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('run-relayauth-typecheck', {
      type: 'deterministic',
      dependsOn: ['run-relayauth-tests'],
      command: `cd ${RELAYAUTH} && npx turbo typecheck --filter=@relayauth/server 2>&1 | tail -30; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('run-cloud-typecheck', {
      type: 'deterministic',
      dependsOn: ['run-relayauth-typecheck'],
      command: `cd ${CLOUD}/packages/relayauth && npm run typecheck 2>&1 | tail -30; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase F: Specialist peer reviews (parallel) ────────────────────

    .step('security-review', {
      agent: 'security-reviewer',
      dependsOn: ['run-relayauth-tests', 'run-relayauth-typecheck', 'run-cloud-typecheck'],
      task: `Security review of the API-key surface.

Scope: api-key generation, storage, lookup, revocation, audit. No spec conformance (other reviewer).

Read every relayauth file the implementer touched. For each, answer:
1. Plaintext key entropy — is it crypto.getRandomValues with at least 32 bytes (256 bits)? Anything weaker?
2. Plaintext key persistence — is it ANYWHERE in the DB schema or any log path? (greps for the variable name should turn up only the constructor and the 201 response builder.)
3. Hash function — SHA-256 is fine; not MD5/SHA-1. Does the lookup compare with a constant-time function? (Hash equality after normalisation is OK; the actual hash bytes are not secret.)
4. Revocation — revoked_at write happens before the response is sent (so a partial failure can't leave a non-revoked but appearing-revoked key)?
5. Audit — every api-key create + revoke + use writes to AuditStorage with action name + actor identity + key prefix (NEVER the plaintext)?
6. Migration — does 0002_api_keys.sql leave any column nullable that should be NOT NULL?
7. Authentication path — can the x-api-key check be bypassed by malformed headers, empty values, header injection?

Output:
- BLOCKING_ISSUES (P0/P1)
- ADVISORY (P2/P3)
- VERDICT: "approve" / "request-changes"

Test + typecheck output:
{{steps.run-relayauth-tests.output}}
{{steps.run-relayauth-typecheck.output}}
{{steps.run-cloud-typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('spec-review', {
      agent: 'spec-reviewer',
      dependsOn: ['run-relayauth-tests', 'run-relayauth-typecheck', 'run-cloud-typecheck'],
      task: `Spec-conformance review of the API-key surface.

Scope: matches OpenAPI + contract test + error catalog. No security depth.

For each route (POST /v1/api-keys, GET /v1/api-keys, POST /v1/api-keys/:id/revoke):
1. URL path matches OpenAPI exactly.
2. Request body shape matches.
3. Response shape matches (ApiKeyCreateResponse: { apiKey, key }; PaginatedApiKeyResponse for GET; ApiKey for revoke).
4. Status codes match (201/200/200, 401/403/404 errors per catalog).
5. Error responses { error, code, status } structure.
6. The contract test's referenced auth modes (bearer-or-apiKey, etc.) line up with the implemented middleware.

For the cloud D1 migration:
1. Naming convention matches existing migrations (0002_<snake_case>.sql).
2. CREATE INDEX statements are present per the spec.

Output: BLOCKING_ISSUES, ADVISORY, VERDICT.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase G: Synthesize + Fix + Re-review + Approval gate ──────────

    .step('synthesize-reviews', {
      agent: 'architect',
      dependsOn: ['security-review', 'spec-review', 'self-review'],
      task: `Build a single prioritised fix list.

Self-review: {{steps.self-review.output}}
Security: {{steps.security-review.output}}
Spec: {{steps.spec-review.output}}

P0 + P1 in. P2 only if one-liner; otherwise defer with TODO comment citing this workflow.
Conflicts: you decide and explain.
If both peer reviewers approved + self-review clean: output "no-fixes-needed".`,
      verification: { type: 'exit_code' },
    })

    .step('fix-issues', {
      agent: 'relayauth-impl',
      dependsOn: ['synthesize-reviews'],
      task: `Apply fixes. If "no-fixes-needed", write "skipped" and exit.

Fix list:
{{steps.synthesize-reviews.output}}

Apply across both repos as needed.`,
      verification: { type: 'exit_code' },
    })

    .step('rerun-relayauth-tests', {
      type: 'deterministic',
      dependsOn: ['fix-issues'],
      command: `cd ${RELAYAUTH} && node --test --import tsx packages/server/src/__tests__/api-keys.test.ts packages/server/src/__tests__/auth-bearer-or-apikey.test.ts packages/server/src/__tests__/identities-apikey-auth.test.ts 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('rerun-typecheck', {
      type: 'deterministic',
      dependsOn: ['rerun-relayauth-tests'],
      command: `cd ${RELAYAUTH} && npx turbo typecheck --filter=@relayauth/server 2>&1 | tail -30; echo --- cloud ---; cd ${CLOUD}/packages/relayauth && npm run typecheck 2>&1 | tail -30; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('security-reapproval', {
      agent: 'security-reviewer',
      dependsOn: ['rerun-relayauth-tests', 'rerun-typecheck'],
      task: `Re-review for security after fixes. Output: VERDICT (approve / still-blocking) + unresolved P0/P1 list if any.

Tests + typecheck:
{{steps.rerun-relayauth-tests.output}}
{{steps.rerun-typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('spec-reapproval', {
      agent: 'spec-reviewer',
      dependsOn: ['rerun-relayauth-tests', 'rerun-typecheck'],
      task: `Re-review for spec-conformance after fixes. Output: VERDICT + unresolved P0/P1 list.`,
      verification: { type: 'exit_code' },
    })

    .step('approval-gate', {
      agent: 'architect',
      dependsOn: ['security-reapproval', 'spec-reapproval'],
      task: `Approval gate.

Security: {{steps.security-reapproval.output}}
Spec: {{steps.spec-reapproval.output}}
Tests: {{steps.rerun-relayauth-tests.output}}
Typecheck: {{steps.rerun-typecheck.output}}

Hard pass criteria — ALL must be true:
- security verdict "approve"
- spec verdict "approve"
- tests EXIT: 0
- typecheck EXIT: 0 (both relayauth + cloud)

If all true: write "PHASE 1 APPROVED" and exit 0.
Else: "PHASE 1 REJECTED" + specific failures, exit 1.`,
      verification: { type: 'exit_code' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({
      cwd: RELAYAUTH,
      onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
    });

  console.log(`\n119 api-keys phase 1: ${result.status}`);
}

main().catch(console.error);
