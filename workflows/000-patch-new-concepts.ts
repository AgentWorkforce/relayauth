/**
 * 000-patch-new-concepts.ts
 *
 * Patches generated workflows to include concepts added after initial generation:
 * 1. Sponsor chain — every agent traces back to a human
 * 2. Behavioral budgets — rate limits per identity with auto-suspend
 * 3. Scope delegation — sub-agents can only get narrower scopes
 * 4. Mandatory expiry — every token expires, no permanent credentials
 *
 * Run: agent-relay run workflows/000-patch-new-concepts.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('000-patch-new-concepts')
  .description('Patch workflows with sponsor chain, budgets, scope delegation, mandatory expiry')
  .pattern('dag')
  .channel('wf-relayauth-patch')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('patcher', {
    cli: 'claude',
    preset: 'lead',
    role: 'Read each workflow file, patch it with missing concepts, write back',
    cwd: ROOT,
  })

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('patch-token-workflows', {
    agent: 'patcher',
    dependsOn: ['read-architecture'],
    task: `Update token-related workflows to include sponsor chain, mandatory expiry, and scope delegation.

New architecture concepts:
{{steps.read-architecture.output}}

Read and update these files:

1. ${ROOT}/workflows/003-token-format-spec.ts
   Add to the task prompts:
   - sponsorId and sponsorChain fields in JWT claims
   - parentTokenId for sub-agent delegation
   - Mandatory expiry: default 1h access, 24h refresh, max 30 days
   - budget claim: { maxActionsPerHour, remaining }

2. ${ROOT}/workflows/014-token-issuance-api.ts
   Add:
   - sponsor is REQUIRED when creating a token
   - parentTokenId: if present, new token scopes must be subset of parent
   - Attempting scope escalation returns 403 + audit event
   - Default TTL enforcement: access=1h, refresh=24h, max=30d
   - budget field in issuance request

3. ${ROOT}/workflows/016-token-revocation-api.ts
   Add:
   - Revocation cascades to all sub-agent tokens (via parentTokenId chain)

4. ${ROOT}/workflows/019-key-rotation.ts
   No changes needed (key rotation is independent of these concepts)

5. ${ROOT}/workflows/020-token-system-e2e.ts
   Add test scenarios:
   - Issue token with sponsor → verify sponsor in claims
   - Issue sub-agent token → verify scopes are narrowed
   - Attempt scope escalation → verify 403
   - Verify mandatory expiry (no token without exp)
   - Revoke parent → verify sub-agent tokens also revoked

Read each file, make targeted edits to the task prompt strings, write back.
Do NOT rewrite the entire file — only modify the relevant task strings.`,
    verification: { type: 'exit_code' },
  })

  .step('patch-identity-workflows', {
    agent: 'patcher',
    dependsOn: ['read-architecture'],
    task: `Update identity-related workflows to include sponsor chain and budgets.

Architecture:
{{steps.read-architecture.output}}

Read and update:

1. ${ROOT}/workflows/021-identity-do.ts
   Add to IdentityDO design:
   - sponsorId (required, human user ID)
   - sponsorChain (array tracing delegation)
   - budget: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
   - budgetUsage: { actionsThisHour, costToday, lastResetAt }

2. ${ROOT}/workflows/022-create-identity-api.ts
   Add:
   - sponsor field is REQUIRED in CreateIdentityInput
   - budget is optional, defaults to org-level budget if not set
   - sponsorChain auto-populated from parent identity

3. ${ROOT}/workflows/026-suspend-identity-api.ts
   Add:
   - Auto-suspend triggered by budget breach (not just manual)
   - Suspend cascades to all sub-agents

4. ${ROOT}/workflows/030-identity-lifecycle-e2e.ts
   Add test scenarios:
   - Create identity with sponsor → verify sponsor in response
   - Create sub-agent → verify sponsorChain includes parent
   - Set budget → exceed budget → verify auto-suspend
   - Suspend parent → verify sub-agents also suspended

Read each file, make targeted edits, write back.`,
    verification: { type: 'exit_code' },
  })

  .step('patch-scope-workflows', {
    agent: 'patcher',
    dependsOn: ['read-architecture'],
    task: `Update scope-related workflows to include delegation and budgets.

Architecture:
{{steps.read-architecture.output}}

Read and update:

1. ${ROOT}/workflows/031-scope-parser.ts
   Add:
   - Parse budget-scoped values like "stripe:orders:approve:≤$5000"
   - Delegation marker in scope format

2. ${ROOT}/workflows/032-scope-matcher.ts
   Add:
   - Scope narrowing: isSubsetOf(parentScopes, childScopes) → boolean
   - Scope intersection: intersect(parentScopes, requestedScopes) → narrowedScopes

3. ${ROOT}/workflows/038-policy-evaluation.ts
   Add:
   - Budget enforcement in policy evaluation
   - Budget exceeded → automatic deny + audit event

4. ${ROOT}/workflows/040-rbac-e2e.ts
   Add test scenarios:
   - Sub-agent scope narrowing works correctly
   - Budget exceeded → action denied
   - Scope escalation attempt → denied + logged

Read each file, make targeted edits, write back.`,
    verification: { type: 'exit_code' },
  })

  .step('patch-audit-workflows', {
    agent: 'patcher',
    dependsOn: ['read-architecture'],
    task: `Update audit-related workflows to include sponsor chain tracing and budget alerts.

Architecture:
{{steps.read-architecture.output}}

Read and update:

1. ${ROOT}/workflows/051-audit-logger.ts
   Add:
   - sponsorId and sponsorChain in every audit entry
   - Budget breach events: "budget.exceeded", "budget.alert"
   - Scope escalation attempt events: "scope.escalation_denied"

2. ${ROOT}/workflows/055-audit-webhooks.ts
   Add:
   - Budget alert webhook: fires when agent hits alertThreshold
   - Auto-suspend webhook: fires when agent is auto-suspended by budget

3. ${ROOT}/workflows/056-identity-activity-api.ts
   Add:
   - Budget usage in activity response: actions/hour, cost/day, % of budget
   - Sponsor chain in activity response

4. ${ROOT}/workflows/058-audit-e2e.ts
   Add test scenarios:
   - Audit entry includes sponsorChain
   - Budget breach generates audit event
   - Budget alert webhook fires at threshold

Read each file, make targeted edits, write back.`,
    verification: { type: 'exit_code' },
  })

  .step('patch-landing-page', {
    agent: 'patcher',
    dependsOn: ['read-architecture'],
    task: `Update the landing page workflow to use the new framing.

Architecture (see Landing Page Framing section):
{{steps.read-architecture.output}}

Read and update ${ROOT}/workflows/100-landing-page.ts:

Update the task prompts to include:
- Hero: "Your agents have keys to everything. Do you know what they're doing?"
- Three panels: Scope, Trace, Revoke
- The 3-line code example from the architecture spec
- "Works with any framework" + logo row
- The $3.2M procurement fraud story as a "Why this matters" section
- Sponsor chain as a key differentiator: "Every action traces back to a human"
- Budget enforcement: "Agents that go rogue get suspended automatically"

Read the file, make targeted edits, write back.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-patches', {
    type: 'deterministic',
    dependsOn: ['patch-token-workflows', 'patch-identity-workflows', 'patch-scope-workflows', 'patch-audit-workflows', 'patch-landing-page'],
    command: 'cd ' + ROOT + '/workflows && echo "=== Sponsor ===" && grep -l "sponsor" *.ts | wc -l && echo "=== Budget ===" && grep -l "budget" *.ts | wc -l && echo "=== Delegation ===" && grep -l "delegation\\|narrowing\\|parentToken\\|sub-agent" *.ts | wc -l && echo "=== Mandatory expiry ===" && grep -l "mandatory.*expir\\|every token expires\\|default.*1h\\|max.*30d" *.ts | wc -l',
    captureOutput: true,
    failOnError: false,
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nPatch workflow: ${result.status}`);
}

main().catch(console.error);
