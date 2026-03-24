/**
 * 077-relayfile-integration.ts
 *
 * Domain 9: Integration
 * Wire relayauth token issuance into the Agent Relay workflow runner so that
 * workflow agent permissions are automatically translated to relayauth scopes,
 * tokens are minted, and relayfile mounts are scoped.
 *
 * This is the "no more --dangerously-allow guilt" workflow:
 * - Workflow declares permissions per agent
 * - Runner translates to relayauth scopes + mints tokens
 * - relayfile mount enforces scopes at the filesystem level
 * - Agent runs with full autonomy inside declared boundaries
 *
 * Depends on: 014 (token issuance), 031 (scope parser), 031-vcs (VCS scopes)
 * Run: agent-relay run workflows/077-relayfile-integration.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAY_SDK = '/Users/khaliqgant/Projects/Agent Workforce/relay';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('077-relayfile-integration')
  .description('Workflow runner + relayauth + relayfile permission enforcement')
  .pattern('dag')
  .channel('wf-relayauth-077')
  .maxConcurrency(3)
  .timeout(1_500_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design integration architecture, review all implementations',
    cwd: ROOT,
  })
  .agent('sdk-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement permission translation and token minting in workflow SDK',
    cwd: RELAY_SDK,
  })
  .agent('auth-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement relayauth token issuance endpoint for workflow agents',
    cwd: ROOT,
  })
  .agent('file-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement relayfile scoped mount API',
    cwd: RELAYFILE,
  })
  .agent('test-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests across all three systems',
    cwd: ROOT,
  })

  // ── Wave 1: Architecture ──────────────────────────────────────────
  .step('design', {
    agent: 'architect',
    task: `Design the workflow → relayauth → relayfile integration.

Read specs/workflow-permissions.md for the full specification.

Design the concrete implementation plan covering:

1. **SDK permissions type** — the TypeScript interface for the permissions
   block in workflow agent definitions. Include fs, vcs, exec, network
   sections with allow/deny arrays.

2. **Permission-to-scope translator** — function that takes a permissions
   object and produces an array of relayauth scope strings. Handle:
   - Glob patterns (/**) to relayauth wildcards (/*)
   - Deny validation (ensure no allow covers a deny)
   - Default denies (no scope = denied)

3. **Token minting flow** — how the workflow runner calls relayauth's
   token issuance API. Include:
   - Identity naming: agent_{workflowName}_{stepName}_{agentName}
   - Sponsor: workflow runner's own identity
   - TTL: step timeout + 5 minute buffer
   - Scope array from the translator

4. **Relayfile mount with token** — how the workflow runner passes the
   scoped token to relayfile mount. The mount daemon needs to use this
   token for all API calls instead of the workspace-wide token.

5. **Default profiles** — profiles.coder(), profiles.reviewer(), etc.
   Define the concrete scope sets for each.

6. **Error handling** — what happens when:
   - Token minting fails (relayauth down)
   - Permission conflict detected at startup
   - Agent hits a denied operation at runtime
   - Token expires mid-step

Write design to docs/workflow-permissions-design.md`,
  })

  // ── Wave 2: SDK permission types + translator ────────────────────
  .step('permission-types', {
    agent: 'sdk-dev',
    dependsOn: ['design'],
    task: `Implement the permissions type and scope translator in the relay SDK.

Read docs/workflow-permissions-design.md for the architecture.

In the workflow SDK (packages/sdk/src/workflows/):

1. Add permissions.ts:
   - AgentPermissions interface with fs, vcs, exec, network sections
   - PermissionProfile type for preset profiles
   - profiles object: coder(), reviewer(), deployer(), researcher()

2. Add scope-translator.ts:
   - translatePermissions(permissions: AgentPermissions): string[]
   - Converts fs.read/write/deny to relayfile:fs:read/write:path scopes
   - Converts vcs.push/branchCreate/deny to relayfile:vcs:*:ref scopes
   - validateDenyConflicts(permissions): throws if allow covers deny

3. Update the workflow builder to accept permissions on .agent():
   .agent('name', { cli, permissions: { fs: { ... } } })

4. Update the runner to:
   - Before spawning an agent, translate permissions to scopes
   - Mint a relayauth token (if relayauth URL is configured)
   - Pass token as RELAYFILE_TOKEN env var to the agent process
   - On step completion, revoke the token

Run: npx tsc --noEmit`,
  })

  // ── Wave 3: relayauth token endpoint ─────────────────────────────
  .step('workflow-token-api', {
    agent: 'auth-dev',
    dependsOn: ['design'],
    task: `Add a workflow-specific token issuance endpoint to relayauth.

In packages/server/src/:

1. Add route: POST /v1/tokens/issue-workflow
   - Accepts: { workflowId, stepName, agentName, scopes, ttlSeconds, sponsor }
   - Validates: scopes are valid relayauth scope strings
   - Validates: sponsor identity exists and has sufficient permissions
   - Validates: requested scopes are subset of sponsor's scopes (delegation)
   - Returns: { token, expiresAt, identity }

2. The identity is auto-created as a transient workflow agent:
   - Name: agent_{workflowId}_{stepName}_{agentName}
   - Type: workflow-agent
   - Sponsor: the provided sponsor identity
   - Auto-expires with the token (no lingering identities)

3. Add route: POST /v1/tokens/revoke-workflow
   - Revokes all tokens for a given workflow agent identity
   - Called on step completion or workflow abort

Run: npm run build && npm run typecheck`,
  })

  // ── Wave 4: relayfile scoped mount ────────────────────────────────
  .step('scoped-mount', {
    agent: 'file-dev',
    dependsOn: ['design'],
    task: `Update relayfile mount daemon to accept per-agent scoped tokens.

In internal/mountsync/syncer.go:

1. Add support for RELAYFILE_TOKEN environment variable
   - If set, use this token for all API calls instead of the mount config token
   - This allows the workflow runner to pass a scoped token per agent

2. When using a scoped token, the mount daemon should:
   - Only sync files the token has read access to
   - Reject local writes to paths the token can't write to
   - Show clear error messages: "Permission denied: token lacks fs:write for /infra/"

3. On token expiry, the mount daemon should:
   - Stop sync operations
   - Preserve local state (don't delete files)
   - Log clear message about token expiry

In internal/httpapi/server.go:
4. The validate-push endpoint (from git-aware-mount) should also accept
   workflow-minted tokens — the VCS scopes work the same regardless of
   who issued the token.

Run: go build ./... && go test ./...`,
  })

  // ── Wave 5: Integration tests ─────────────────────────────────────
  .step('integration-tests', {
    agent: 'test-dev',
    dependsOn: ['permission-types', 'workflow-token-api', 'scoped-mount'],
    task: `Write integration tests for the full permission pipeline.

Test the complete flow:
1. Define a workflow with permissions
2. Translate permissions to scopes
3. Mint a token with those scopes
4. Use the token against relayfile
5. Verify allowed operations succeed
6. Verify denied operations fail with clear errors

Specific test cases:

a) "Prevent push to main" end-to-end:
   - permissions: { vcs: { push: ['refs/heads/feat/*'] } }
   - Translates to: relayfile:vcs:push:refs/heads/feat/*
   - Token minted with that scope
   - validate-push for refs/heads/feat/test → 200 allowed
   - validate-push for refs/heads/main → 403 denied

b) "Read-only reviewer" end-to-end:
   - permissions: { fs: { read: ['*'], write: [] } }
   - Translates to: relayfile:fs:read:*
   - Token minted (no write scopes)
   - Read file → 200
   - Write file → 403

c) "Scoped coder" end-to-end:
   - permissions: { fs: { read: ['*'], write: ['/src/**'], deny: ['/.env'] } }
   - Write to /src/index.ts → 200
   - Write to /infra/deploy.yaml → 403
   - Read /.env → 200 (read allowed)
   - Write /.env → 403 (deny)

d) "Permission conflict detection":
   - permissions: { fs: { write: ['/*'], deny: ['/secrets/'] } }
   - Should throw at validation time: write:/* covers /secrets/

Run: npm run test`,
  })

  // ── Wave 6: Review ────────────────────────────────────────────────
  .step('review', {
    agent: 'architect',
    dependsOn: ['integration-tests'],
    task: `Final review of the complete integration.

Verify:
1. Permission declaration UX is clean and intuitive
2. Scope translation is correct and complete
3. Token lifecycle is properly managed (mint → use → revoke)
4. Denied operations produce useful error messages for agents
5. Audit trail captures all permission events
6. Default profiles are practical and secure
7. The spec (workflow-permissions.md) matches implementation
8. No security gaps in the token flow

Write final review to docs/workflow-permissions-review.md`,
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n077 Relayfile Integration: ${result.status}`);
}

main().catch(console.error);
