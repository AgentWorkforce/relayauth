/**
 * 122-cloud-cutover-phase3b.ts
 *
 * spec: specs/api-keys-and-rs256-migration.md (Phase 3 — cutover side)
 * depends on: 120 (RS256 path in @relayauth/server), 121 (SDK dual-verify
 *             published to npm and adopted by every consumer that calls
 *             specialist's verifyBearerToken — sage, any others)
 *
 * Cuts production over to RS256. Three flag-controlled steps, each behind
 * an approval gate that re-reads tail logs from CloudWatch / Cloudflare:
 *
 *   1. Generate the production RSA keypair, store private key as a SST
 *      secret, set RELAYAUTH_SIGNING_KEY_PEM_PUBLIC env so JWKS publishes
 *      the new key alongside the existing HS256 entry.
 *   2. Flip RELAYAUTH_SIGNING_ALG=RS256. New tokens are RS256-signed.
 *      Existing HS256 tokens continue to verify until they expire (1h TTL).
 *   3. After a 90-minute soak (TTL + 30min margin), drop HS256 from JWKS
 *      and set RELAYAUTH_VERIFIER_ACCEPT_HS256=false on every consumer.
 *
 * This is the production cryptographic cutover. The architect agent
 * pauses for a human "go/no-go" decision before each step.
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
  const result = await workflow('122-cloud-cutover-phase3b')
    .description('Production cutover from HS256 to RS256, flag-gated, with human approval at each step')
    .pattern('dag')
    .channel('wf-relayauth-122')
    .maxConcurrency(2)
    .timeout(7_200_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Drive cutover, request human go/no-go between steps, abort on red signal', cwd: CLOUD })
    .agent('cloud-impl', { cli: 'codex', preset: 'worker', role: 'Cloud SST + GitHub Actions changes', cwd: CLOUD })
    .agent('observability', { cli: 'claude', preset: 'reviewer', role: 'Read CloudWatch + Cloudflare worker tails, decide health', cwd: CLOUD })
    .agent('rollback-reviewer', { cli: 'claude', preset: 'reviewer', role: 'For every change, verify a rollback path exists and is documented', cwd: CLOUD })

    .step('read-spec', { type: 'deterministic', command: `cat ${RELAYAUTH}/specs/api-keys-and-rs256-migration.md`, captureOutput: true })

    .step('precondition-check', {
      type: 'deterministic',
      command: `set -e
        echo === verify @relayauth/server published with RS256 path === ;
        npm view @relayauth/server@latest version ;
        echo === verify @relayauth/sdk published with dual-verify === ;
        npm view @relayauth/sdk@latest version ;
        echo === verify cloud sage-worker bumped to a sage version that uses dual-verify === ;
        cat ${CLOUD}/packages/sage-worker/package.json | grep agentworkforce/sage ;
        echo === confirm SAGE_RELAYAUTH_API_KEY GitHub secret exists === ;
        gh secret list --repo AgentWorkforce/cloud | grep SAGE_RELAYAUTH_API_KEY || (echo MISSING_SECRET; exit 1) ;
        echo === ALL_PRECONDITIONS_OK ===`,
      captureOutput: true,
      failOnError: true,
    })

    // ── STEP 1: Add RSA public key to JWKS (signer still HS256) ────────

    .step('step1-prepare-rsa-key', {
      agent: 'cloud-impl',
      dependsOn: ['precondition-check', 'read-spec'],
      task: `Step 1 of cutover — publish the RSA public key in JWKS, signer still produces HS256.

DO NOT execute openssl or push secrets in this step. Just produce the runbook artifact for the human operator:

1. Write ${CLOUD}/docs/rs256-cutover-runbook.md with:
   - The exact openssl commands to generate a 4096-bit RSA private key
   - The exact 'sst secret set RelayauthSigningKeyPem' command (production stage)
   - The exact 'sst secret set RelayauthSigningKeyPemPublic' command
   - The expected GitHub Actions secret names + values to set
   - The expected env var bindings on the relayauth worker (RELAYAUTH_SIGNING_KEY_PEM, RELAYAUTH_SIGNING_KEY_PEM_PUBLIC; do NOT set RELAYAUTH_SIGNING_ALG yet)
   - The exact 'curl /.well-known/jwks.json' to confirm the RSA JWK is now alongside the HS256 entry
   - The rollback procedure (delete the env vars, re-deploy)

2. Update ${CLOUD}/infra/relayauth.ts:
   - Declare 'sst.Secret("RelayauthSigningKeyPem")' and 'sst.Secret("RelayauthSigningKeyPemPublic")'
   - Bind them as secret_text on the worker
   - DO NOT bind RELAYAUTH_SIGNING_ALG yet (that's step 2)

3. Update ${CLOUD}/.github/workflows/deploy.yml + scripts/seed-sst-secrets.sh:
   - Pass RELAYAUTH_SIGNING_KEY_PEM + RELAYAUTH_SIGNING_KEY_PEM_PUBLIC from GitHub secrets
   - Strict required (set_secret, not set_secret_or_default) — deploy fails loud if unset

Open a PR. Architect will review and request human go/no-go before merging.`,
      verification: { type: 'exit_code' },
    })

    .step('step1-self-review', { agent: 'cloud-impl', dependsOn: ['step1-prepare-rsa-key'], task: `Self-review the runbook + infra changes. Check the curl + sst commands actually compose; verify the env names match what 120 expects @relayauth/server to read; confirm rollback steps actually undo the changes.`, verification: { type: 'exit_code' } })

    .step('step1-rollback-review', { agent: 'rollback-reviewer', dependsOn: ['step1-self-review'], task: `Confirm the runbook has a rollback procedure that restores production to its current state in <5 minutes. VERDICT (approve / reject) + missing rollback paths.` , verification: { type: 'exit_code' } })

    .step('step1-human-gate', {
      type: 'deterministic',
      dependsOn: ['step1-rollback-review'],
      command: `echo "===== HUMAN GO/NO-GO REQUIRED ====="; echo "Step 1 (RSA public key in JWKS) prepared."; echo "Read ${CLOUD}/docs/rs256-cutover-runbook.md, run the openssl + sst secret commands manually, merge the infra PR, and confirm:"; echo "  curl https://api.relayauth.dev/.well-known/jwks.json | jq '.keys[]'"; echo "  -- expected: at least one entry with kty=RSA, use=sig, alg=RS256"; echo ""; echo "Once confirmed, mark this workflow's go/no-go file:"; echo "  touch ${RELAYAUTH}/.cutover-step1-approved"; echo ""; echo "Workflow waits for that file before proceeding to step 2."; until [ -f ${RELAYAUTH}/.cutover-step1-approved ]; do sleep 30; done; echo OK_STEP1_APPROVED`,
      captureOutput: true,
      failOnError: true,
    })

    // ── STEP 2: Flip the signer to RS256 ───────────────────────────────

    .step('step2-flip-signer', {
      agent: 'cloud-impl',
      dependsOn: ['step1-human-gate'],
      task: `Step 2 — set RELAYAUTH_SIGNING_ALG=RS256 on the relayauth worker so new tokens are RS256-signed. Existing HS256 tokens continue to verify until they expire.

1. Update ${CLOUD}/infra/relayauth.ts: add 'RELAYAUTH_SIGNING_ALG: "RS256"' to the worker's environment block.
2. Open a small PR with that one-line change.
3. Update the runbook with: "After merge → deploy → confirm 'curl /v1/tokens' produces a token with header.alg=RS256". Include the exact curl + jq parse to verify.

Do NOT change the verifier-side flag yet. HS256 tokens still in flight must continue to verify.`,
      verification: { type: 'exit_code' },
    })

    .step('step2-self-review', { agent: 'cloud-impl', dependsOn: ['step2-flip-signer'], task: `Self-review. The change is one line; confirm it doesn't accidentally remove any existing env vars and that the deploy script still passes RELAYAUTH_SIGNING_KEY_PEM (the private key the new alg requires).`, verification: { type: 'exit_code' } })

    .step('step2-human-gate', {
      type: 'deterministic',
      dependsOn: ['step2-self-review'],
      command: `echo "===== HUMAN GO/NO-GO REQUIRED ====="; echo "Step 2 (signer cutover) prepared."; echo "Merge + deploy. Then verify:"; echo "  1. curl /v1/tokens with a valid api-key — token header.alg should be RS256"; echo "  2. specialist worker tail — verifyBearerToken should accept the new tokens"; echo "  3. sage tail — no max_iterations_reached for at least 10 minutes"; echo ""; echo "If healthy, touch ${RELAYAUTH}/.cutover-step2-approved"; echo "If broken, ROLLBACK: revert the env var to delete RELAYAUTH_SIGNING_ALG and redeploy. Then touch ${RELAYAUTH}/.cutover-step2-rolled-back"; until [ -f ${RELAYAUTH}/.cutover-step2-approved ] || [ -f ${RELAYAUTH}/.cutover-step2-rolled-back ]; do sleep 30; done; if [ -f ${RELAYAUTH}/.cutover-step2-rolled-back ]; then echo ROLLBACK_TAKEN; exit 1; fi; echo OK_STEP2_APPROVED`,
      captureOutput: true,
      failOnError: true,
    })

    // ── STEP 3: Sunset HS256 (after 90 min soak) ───────────────────────

    .step('step3-soak-window', {
      type: 'deterministic',
      dependsOn: ['step2-human-gate'],
      command: `echo "===== SOAK WINDOW ====="; echo "Waiting 90 minutes (1h token TTL + 30min margin) before sunsetting HS256."; echo "Use this window to monitor:"; echo "  - sage tail — confirm specialist tools work over this window"; echo "  - cloud + relayauth Cloudflare tails — no verification spikes"; echo ""; echo "If any failures appear, touch ${RELAYAUTH}/.cutover-soak-aborted to abort."; for i in $(seq 1 90); do sleep 60; if [ -f ${RELAYAUTH}/.cutover-soak-aborted ]; then echo SOAK_ABORTED; exit 1; fi; if [ $((i % 15)) -eq 0 ]; then echo "soak: \${i}/90 min"; fi; done; echo OK_SOAK_COMPLETE`,
      captureOutput: true,
      failOnError: true,
    })

    .step('observability-check', {
      agent: 'observability',
      dependsOn: ['step3-soak-window'],
      task: `Pull the last 90 minutes of logs from:
1. The relayauth worker (Cloudflare tail or wrangler tail relayauth-api)
2. The specialist worker (wrangler tail specialist)
3. The sage worker (wrangler tail sage)

Look for:
- token-verification failures
- max_iterations_reached in sage
- 401s in any worker that previously succeeded
- any unhandled exception that didn't exist before step 2

Output:
- VERDICT: "healthy" / "unhealthy"
- If unhealthy, list specific error patterns + counts
- If healthy, signal that step 3 (HS256 sunset) can proceed`,
      verification: { type: 'exit_code' },
    })

    .step('step3-sunset-hs256', {
      agent: 'cloud-impl',
      dependsOn: ['observability-check'],
      task: `If observability verdict is "healthy", prepare the HS256 sunset:

1. Update ${CLOUD}/infra/relayauth.ts: remove the SIGNING_KEY env binding (the HS256 secret); the JWKS will stop publishing the HS256 entry on next deploy.
2. Update sage worker env in ${CLOUD}/infra/sage.ts: set RELAYAUTH_VERIFIER_ACCEPT_HS256="false" so the SDK strict-rejects any HS256 token that somehow appears.
3. Open a single PR with both changes + a runbook entry: "After deploy, confirm jwks.json has only RSA entries; sage tail should show no HS256 verifications."

If observability verdict is "unhealthy", do NOT proceed. Write "BLOCKED: <reason>" and exit 1. The architect will assess whether to roll back step 2 or hold longer.`,
      verification: { type: 'exit_code' },
    })

    .step('step3-human-gate', {
      type: 'deterministic',
      dependsOn: ['step3-sunset-hs256'],
      command: `echo "===== HUMAN GO/NO-GO REQUIRED ====="; echo "Step 3 (HS256 sunset) prepared."; echo "Merge + deploy. Then verify:"; echo "  curl /.well-known/jwks.json — only RSA keys present, no HS256"; echo "  sage tail — clean for 30 minutes"; echo "Touch ${RELAYAUTH}/.cutover-step3-approved when confirmed."; until [ -f ${RELAYAUTH}/.cutover-step3-approved ]; do sleep 30; done; echo OK_CUTOVER_COMPLETE`,
      captureOutput: true,
      failOnError: true,
    })

    .step('approval-gate', {
      agent: 'architect',
      dependsOn: ['step3-human-gate'],
      task: `Final approval gate.

All three step gates passed. Cutover is complete.

Confirm:
- Production /v1/tokens issues RS256 tokens
- JWKS publishes only RSA keys
- All consumers (sage, specialist, others) verify cleanly
- No regression in sage's harness completion rate over the soak window

Write "RS256 CUTOVER COMPLETE" with the timestamp and key fingerprint of the live signing key.`,
      verification: { type: 'exit_code' },
    })

    .onError('retry', { maxRetries: 0, retryDelayMs: 0 })
    .run({ cwd: CLOUD, onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()) });

  console.log(`\n122 cloud-cutover phase 3b: ${result.status}`);
}

main().catch(console.error);
