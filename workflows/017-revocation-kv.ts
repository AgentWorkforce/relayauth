/**
 * 017-revocation-kv.ts
 *
 * Domain 2: Token System
 * KV-based revocation list with global propagation
 *
 * Depends on: 016
 * Run: agent-relay run workflows/017-revocation-kv.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('017-revocation-kv')
  .description('KV-based revocation list with global propagation')
  .pattern('dag')
  .channel('wf-relayauth-017')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design KV revocation store, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for KV revocation store',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement KV revocation store',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review KV revocation for propagation, TTL handling, edge cases',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-revocation-engine', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/engine/token-revocation.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-architecture', 'read-revocation-engine', 'read-env', 'read-test-helpers'],
    task: `Write tests for the KV-based revocation store.

Architecture (KV section):
{{steps.read-architecture.output}}

Revocation engine:
{{steps.read-revocation-engine.output}}

Server env:
{{steps.read-env.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/server/src/__tests__/revocation-kv.test.ts.
Use node:test + node:assert/strict.

Test these behaviors:
1. addToRevocationList(jti, metadata, kv) writes to KV with TTL
2. isTokenRevoked(jti, kv) returns true for revoked tokens
3. isTokenRevoked returns false for non-revoked tokens
4. KV entry expires after TTL (token expiry time)
5. Bulk revocation: revokeSession(sid, jtis[], kv) revokes all tokens
6. getRevocationMetadata(jti, kv) returns { revokedAt, reason, revokedBy }
7. Revocation list cleanup: expired entries auto-removed by KV TTL
8. KV key format: "revoked:{jti}" for single tokens
9. KV key format: "session:{sid}" for session-level entries
10. Handle KV write failures gracefully (retry once)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/revocation-kv.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement-kv', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-revocation-engine', 'read-env'],
    task: `Implement the KV-based revocation store.

Revocation engine:
{{steps.read-revocation-engine.output}}

Server env:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/server/src/engine/revocation-kv.ts:

1. RevocationStore class wrapping KVNamespace:
   - constructor(kv: KVNamespace)
   - addToRevocationList(jti: string, metadata: RevocationMetadata, ttlSeconds: number): Promise<void>
   - isTokenRevoked(jti: string): Promise<boolean>
   - getRevocationMetadata(jti: string): Promise<RevocationMetadata | null>
   - revokeSession(sid: string, jtis: string[], ttlSeconds: number): Promise<void>
   - isSessionRevoked(sid: string): Promise<boolean>

2. RevocationMetadata type: { revokedAt: string, reason?: string, revokedBy?: string }

3. KV key patterns:
   - "revoked:{jti}" → metadata JSON
   - "session:{sid}" → { revoked: true, revokedAt }

4. All writes include expirationTtl for automatic cleanup

5. Update token-revocation.ts to use RevocationStore instead of raw KV calls

Export RevocationStore and types. Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement-kv'],
    command: `test -f ${ROOT}/packages/server/src/engine/revocation-kv.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/revocation-kv.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the KV revocation store implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. KV TTL is correctly set to remaining token lifetime
2. Session-level revocation properly tracks all session tokens
3. Key format is consistent and documented
4. Metadata stored is minimal (no sensitive data in KV values)
5. Graceful handling of KV failures
6. Token-revocation engine properly updated to use RevocationStore
7. CF Workers KV API used correctly (put, get, delete)

List issues to fix (or confirm all good).`,
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/revocation-kv.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n017 Revocation KV: ${result.status}`);
}

main().catch(console.error);
