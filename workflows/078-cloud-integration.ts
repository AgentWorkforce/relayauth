/**
 * 078-cloud-integration.ts
 *
 * Domain 9: Integration
 * cloud launcher mints relayauth tokens for workflow runs
 *
 * Depends on: 014, 059
 * Run: agent-relay run workflows/078-cloud-integration.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';
const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
const result = await workflow('078-cloud-integration')
  .description('Cloud launcher mints relayauth tokens for workflow runs')
  .pattern('dag')
  .channel('wf-relayauth-078')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan cloud integration, fix issues after review',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests for cloud token minting',
    cwd: ROOT,
  })
  .agent('impl-cloud', {
    cli: 'codex',
    preset: 'worker',
    role: 'Modify cloud launcher to mint relayauth tokens',
    cwd: CLOUD,
  })
  .agent('impl-sdk', {
    cli: 'codex',
    preset: 'worker',
    role: 'Add cloud integration helpers to relayauth SDK',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review cloud integration for security and token lifecycle',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-cloud-launcher', {
    type: 'deterministic',
    command: `find ${CLOUD} -name "launcher*" -o -name "workflow-runner*" | head -5 | xargs cat 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-cloud-auth', {
    type: 'deterministic',
    command: `find ${CLOUD} -name "auth*" -o -name "token*" | head -5 | xargs cat 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-sdk-client', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-cloud-launcher', 'read-cloud-auth', 'read-sdk-client', 'read-token-types'],
    task: `Plan the cloud integration with relayauth.

Cloud launcher:
{{steps.read-cloud-launcher.output}}

Cloud auth:
{{steps.read-cloud-auth.output}}

SDK client:
{{steps.read-sdk-client.output}}

Token types:
{{steps.read-token-types.output}}

Write a plan to ${ROOT}/docs/078-plan.md covering:
1. Cloud launcher uses RelayAuthClient to mint tokens per workflow run
2. Token scopes derived from workflow definition (what planes it needs)
3. Short-lived tokens (15min) with no refresh for workflow runs
4. Token revocation when workflow completes or is cancelled
5. Files to create/modify in both repos`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan', 'read-test-helpers'],
    task: `Write integration tests for cloud + relayauth.

Plan:
{{steps.plan.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/integration/cloud.test.ts.
Use node:test + node:assert/strict. Test:
1. Cloud launcher mints a scoped token via RelayAuthClient
2. Minted token has correct scopes from workflow definition
3. Token is short-lived (15min expiry)
4. Token is revoked when workflow completes
5. Revoked token is rejected by verification`,
    verification: { type: 'exit_code' },
  })

  .step('implement-cloud-launcher', {
    agent: 'impl-cloud',
    dependsOn: ['plan', 'read-cloud-launcher', 'read-cloud-auth'],
    task: `Update cloud launcher to mint relayauth tokens.

Plan:
{{steps.plan.output}}

Current launcher:
{{steps.read-cloud-launcher.output}}

Current auth:
{{steps.read-cloud-auth.output}}

Modify cloud launcher to:
1. Import RelayAuthClient from @relayauth/sdk
2. On workflow start: mint a scoped token via POST /v1/tokens
3. Derive scopes from workflow definition (cloud:workflow:run + plane access)
4. Pass token to workflow agents via environment
5. On workflow end: revoke the token via POST /v1/tokens/revoke`,
    verification: { type: 'exit_code' },
  })

  .step('implement-sdk-adapter', {
    agent: 'impl-sdk',
    dependsOn: ['plan', 'read-sdk-client', 'read-token-types'],
    task: `Add cloud integration helpers to the SDK.

Plan:
{{steps.plan.output}}

SDK client:
{{steps.read-sdk-client.output}}

Token types:
{{steps.read-token-types.output}}

Create ${ROOT}/packages/sdk/typescript/src/integrations/cloud.ts:
1. createWorkflowToken(client, workflowDef) — mint a scoped short-lived token
2. revokeWorkflowToken(client, tokenId) — revoke on completion
3. CLOUD_SCOPES — constants for cloud scope patterns
4. deriveWorkflowScopes(workflowDef) — extract required scopes
Export from ${ROOT}/packages/sdk/typescript/src/index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-cloud-launcher', 'implement-sdk-adapter'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/integration/cloud.test.ts && echo "test OK" || echo "test MISSING"; test -f ${ROOT}/packages/sdk/typescript/src/integrations/cloud.ts && echo "sdk-adapter OK" || echo "sdk-adapter MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/cloud.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
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
    task: `Review the cloud integration.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation files and check:
1. Tokens are properly scoped to workflow needs
2. Short-lived tokens (no long-lived credentials leaking)
3. Token revocation on workflow completion
4. Workflow agents cannot escalate scopes
5. Error handling when relayauth is unavailable
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
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/integration/cloud.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n078 Cloud Integration: ${result.status}`);
}

main().catch(console.error);
