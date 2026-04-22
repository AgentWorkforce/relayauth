/**
 * 123-bootstrap-sage-key-phase4.ts
 *
 * spec: specs/api-keys-and-rs256-migration.md (Phase 4)
 * depends on: 119 (api keys exist), 122 (cutover complete)
 *
 * Operational workflow — produces the runbook + scripts to provision
 * sage's RelayAuth API key, sets it as a GitHub Actions secret, and
 * triggers the sage release + cloud bump + deploy chain that lights up
 * specialist auth end-to-end.
 *
 * Most steps are runbook generation rather than direct execution; some
 * actions need a human operator with admin credentials.
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const SAGE = '/Users/khaliqgant/Projects/AgentWorkforce/sage';

async function main() {
  const result = await workflow('123-bootstrap-sage-key-phase4')
    .description('Provision sage RelayAuth API key, wire into GitHub Actions, kick off sage release + cloud deploy')
    .pattern('dag')
    .channel('wf-relayauth-123')
    .maxConcurrency(2)
    .timeout(2_400_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Lead, gate human steps, drive sage + cloud release chain', cwd: CLOUD })
    .agent('runbook-author', { cli: 'codex', preset: 'worker', role: 'Write the bootstrap runbook + verification scripts', cwd: CLOUD })
    .agent('security-reviewer', { cli: 'claude', preset: 'reviewer', role: 'API-key handling: scope minimisation, rotation plan, secret-store posture', cwd: CLOUD })

    .step('preconditions', {
      type: 'deterministic',
      command: `set -e
        echo === verify api-keys endpoint live === ;
        curl -fsS -o /dev/null -w 'HTTP %{http_code}\\n' https://api.relayauth.dev/v1/api-keys -X POST -H 'content-type: application/json' -d '{}' ;
        # Without auth this should be 401, not 404. 404 means phase 1 did not deploy.
        echo === verify RS256 cutover complete === ;
        curl -fsS https://api.relayauth.dev/.well-known/jwks.json | jq '.keys[] | {kty, alg, kid}' ;
        # Expect kty=RSA, alg=RS256.
        echo === verify sage PR 97 + cloud PR 280 still open or merged === ;
        gh pr view 97 --repo AgentWorkforce/sage --json state,mergedAt ;
        gh pr view 280 --repo AgentWorkforce/cloud --json state,mergedAt`,
      captureOutput: true,
      failOnError: true,
    })

    .step('write-runbook', {
      agent: 'runbook-author',
      dependsOn: ['preconditions'],
      task: `Write ${CLOUD}/docs/sage-relayauth-bootstrap.md with the complete operator runbook.

Sections:
1. Prereqs (Phase 0-3 complete; admin bearer JWT available)
2. Generate admin bearer (use scripts/generate-dev-token.sh in relayauth as reference; production version uses RSA private key + admin identity)
3. Create sage's API key via curl:
   curl -X POST https://api.relayauth.dev/v1/api-keys \\
     -H "Authorization: Bearer <admin>" \\
     -H "content-type: application/json" \\
     -d '{"name":"sage-specialist-caller","scopes":["specialist:invoke"]}'
   Save the returned 'key' value (returned exactly once).
4. Set GitHub Actions secret:
   gh secret set SAGE_RELAYAUTH_API_KEY --repo AgentWorkforce/cloud --body "<key>"
5. Verify the secret is reachable from CI:
   - Trigger a deploy-staging workflow_dispatch
   - In the Seed SST stage secrets step, expect SageRelayauthApiKey set successfully (no "Missing required GitHub secret" error)
6. Merge sage PR #97 if not already merged.
7. Wait for the next sage release (auto via release workflow, or manual npm publish).
8. Run the Bump sage-worker Sage dependency workflow.
9. The bump produces a commit on cloud main. Deploy fires automatically.
10. Verify end-to-end:
    - tail sage worker
    - send a Slack DM "list open PRs in AgentWorkforce/sage"
    - confirm reply contains real GitHub data (not the generic fallback)
11. Rotation plan: API keys rotated quarterly via the same flow, old key revoked via POST /v1/api-keys/:id/revoke.

Rollback procedure (if anything goes wrong at any step) included for each.`,
      verification: { type: 'exit_code' },
    })

    .step('write-helper-scripts', {
      agent: 'runbook-author',
      dependsOn: ['write-runbook'],
      task: `Write ${CLOUD}/scripts/bootstrap-sage-relayauth-key.sh.

The script:
1. Reads RELAYAUTH_ADMIN_BEARER from env (errors if unset, with link to admin-bearer-generation docs).
2. POSTs to /v1/api-keys with the documented body.
3. Parses the response, prints the key value to stdout (operator captures it).
4. Reminds the operator to immediately set the GitHub Actions secret + delete the local copy.

Make the script set -euo pipefail, fail clearly on any HTTP error, and never log the key value to a file.`,
      verification: { type: 'exit_code' },
    })

    .step('self-review', {
      agent: 'runbook-author',
      dependsOn: ['write-helper-scripts'],
      task: `Self-review the runbook + script.

Specifically:
1. Are there any commands that would expose the API key value in shell history or process listings?
2. Does the runbook explicitly say "do not paste the key into Slack/Linear/etc."?
3. Is rotation documented?
4. Does every step have a rollback?

End with "self-review clean" or list issues.`,
      verification: { type: 'exit_code' },
    })

    .step('security-review', {
      agent: 'security-reviewer',
      dependsOn: ['self-review'],
      task: `Security review of the runbook + bootstrap script.

For each step, evaluate:
1. API-key scoping: is "specialist:invoke" the minimum scope sage needs? Could any field grant more than required?
2. Storage posture: GitHub Actions secret store is fine for CI; the runbook should NOT advise storing the key anywhere else (no .env, no 1Password without TTL, no Slack DM).
3. Bootstrap admin bearer: how is it generated? Where is it stored? How is it rotated?
4. Logging: does the bootstrap script avoid logging the API key, even in error paths?
5. Rotation plan: is the cadence documented (quarterly per spec) and is the revoke path tested?

Output: VERDICT (approve / request-changes), BLOCKING_ISSUES, ADVISORY.`,
      verification: { type: 'exit_code' },
    })

    .step('synthesize', { agent: 'architect', dependsOn: ['security-review', 'self-review'], task: `Synthesize. Self: {{steps.self-review.output}}\nSecurity: {{steps.security-review.output}}\n\nP0+P1 in. "no-fixes-needed" if clean.`, verification: { type: 'exit_code' } })

    .step('fix', { agent: 'runbook-author', dependsOn: ['synthesize'], task: `Apply: {{steps.synthesize.output}}`, verification: { type: 'exit_code' } })

    .step('security-reapproval', { agent: 'security-reviewer', dependsOn: ['fix'], task: `Re-review the patched runbook + script. VERDICT + unresolved.`, verification: { type: 'exit_code' } })

    .step('approval-gate', {
      agent: 'architect',
      dependsOn: ['security-reapproval'],
      task: `Approval gate.

Security: {{steps.security-reapproval.output}}

If approve: "PHASE 4 ARTIFACTS APPROVED" — operator can now follow the runbook to actually provision the key.

NOTE: This workflow does NOT execute the bootstrap itself (it requires an admin bearer that this agent should not see). The human operator runs ${CLOUD}/scripts/bootstrap-sage-relayauth-key.sh manually after this workflow's PR is merged.`,
      verification: { type: 'exit_code' },
    })

    // ── After human runs the bootstrap, this workflow waits for the
    // sage release + bump + deploy chain to complete and verifies. ─────

    .step('wait-for-sage-bump-and-deploy', {
      type: 'deterministic',
      dependsOn: ['approval-gate'],
      command: `echo "===== HUMAN STEPS REQUIRED ====="; echo "Run ${CLOUD}/scripts/bootstrap-sage-relayauth-key.sh and follow the runbook."; echo "After merging sage #97, releasing sage, running Bump sage-worker, and deploy succeeds, touch ${RELAYAUTH}/.phase4-bootstrap-deployed"; until [ -f ${RELAYAUTH}/.phase4-bootstrap-deployed ]; do sleep 60; done; echo OK_BOOTSTRAP_DEPLOYED`,
      captureOutput: true,
      failOnError: true,
    })

    .step('end-to-end-verify', {
      type: 'deterministic',
      dependsOn: ['wait-for-sage-bump-and-deploy'],
      command: `echo "===== END-TO-END VERIFICATION ====="; echo "Tail sage worker for 5 minutes, send a Slack DM that requires GitHub specialist."; echo "Run: CLOUDFLARE_API_TOKEN=... wrangler tail sage --format pretty | grep -E 'incomplete harness outcome|github.enumerate'"; echo "Expected: NO 'max_iterations_reached' for at least 5 minutes after a fresh GitHub query."; echo "Touch ${RELAYAUTH}/.phase4-verified when confirmed."; until [ -f ${RELAYAUTH}/.phase4-verified ]; do sleep 30; done; echo OK_END_TO_END_VERIFIED`,
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 0, retryDelayMs: 0 })
    .run({ cwd: CLOUD, onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()) });

  console.log(`\n123 bootstrap-sage-key phase 4: ${result.status}`);
}

main().catch(console.error);
