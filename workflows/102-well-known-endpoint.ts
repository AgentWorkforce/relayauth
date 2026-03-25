/**
 * 102-well-known-endpoint.ts
 *
 * Domain 13: Discovery & Ecosystem
 * GET /.well-known/agent-configuration — server discovery endpoint
 *
 * Depends on: 101, 012
 * Run: agent-relay run workflows/102-well-known-endpoint.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('102-well-known-endpoint')
  .description('Implement GET /.well-known/agent-configuration discovery endpoint')
  .pattern('dag')
  .channel('wf-relayauth-102')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design discovery endpoint, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for well-known agent-configuration endpoint',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement well-known agent-configuration endpoint',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review endpoint for spec compliance and security',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/well-known-agent-configuration.md`,
    captureOutput: true,
  })

  .step('read-discovery-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/discovery.ts`,
    captureOutput: true,
  })

  .step('read-well-known-routes', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/well-known.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-env', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/env.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-spec', 'read-discovery-types', 'read-test-helpers'],
    task: `Write tests for the well-known agent-configuration endpoint.

Spec:
{{steps.read-spec.output}}

Discovery types:
{{steps.read-discovery-types.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/well-known-discovery.test.ts.
Use node:test + node:assert/strict.

Test:
1. GET /.well-known/agent-configuration returns 200 with correct JSON
2. Response includes issuer, jwks_uri, token_endpoint, identity_endpoint
3. Response includes supported_scopes with proper format
4. Response includes supported_grant_types
5. Cache-Control header is set (public, max-age=3600)
6. Content-Type is application/json
7. Response validates against AgentConfiguration type`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/well-known-discovery.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-spec', 'read-discovery-types', 'read-well-known-routes', 'read-env'],
    task: `Implement the well-known agent-configuration endpoint.

Spec:
{{steps.read-spec.output}}

Discovery types:
{{steps.read-discovery-types.output}}

Existing well-known routes:
{{steps.read-well-known-routes.output}}

Env bindings:
{{steps.read-env.output}}

Tests to pass:
{{steps.write-tests.output}}

Add a GET /.well-known/agent-configuration route to the existing well-known routes file
(or create ${ROOT}/packages/server/src/routes/discovery.ts if no well-known file exists).

The endpoint should:
- Return AgentConfiguration JSON
- Build response from server env (issuer URL, etc.)
- Set Cache-Control: public, max-age=3600
- Include all endpoints from the architecture
- Include relayauth-specific fields (sponsor_required, budget_support, scope_delegation)
- Register the route in the main worker/app router`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `ls ${ROOT}/packages/server/src/routes/discovery.ts ${ROOT}/packages/server/src/routes/well-known.ts 2>/dev/null | head -5; echo "---"; grep -r "agent-configuration" ${ROOT}/packages/server/src/routes/ 2>/dev/null | head -5 || echo "NO ROUTE FOUND"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/well-known-discovery.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the well-known agent-configuration endpoint.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Response schema matches the spec exactly
2. No sensitive info exposed (no private keys, internal URLs)
3. Cache headers set correctly
4. Consistent with existing JWKS endpoint pattern
5. Route properly registered in the app
List issues to fix.`,
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/well-known-discovery.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n102 Well-Known Endpoint: ${result.status}`);
}

main().catch(console.error);
