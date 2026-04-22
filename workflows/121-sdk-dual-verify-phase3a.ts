/**
 * 121-sdk-dual-verify-phase3a.ts
 *
 * spec: specs/api-keys-and-rs256-migration.md (Phase 3 — verifier side)
 * depends on: 120 (RS256 signing path exists in @relayauth/server)
 *
 * Updates @relayauth/sdk's TokenVerifier to accept BOTH RS256 (new) and
 * HS256 (current production) during the cutover window. Without this,
 * once the signer flips to RS256 (in 121's downstream cloud cutover),
 * any verifier still on the old SDK fails closed.
 *
 * Critical that this lands and propagates to all consumers BEFORE the
 * signer cuts over. Same review template; crypto-reviewer is the gate.
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
  const result = await workflow('121-sdk-dual-verify-phase3a')
    .description('TokenVerifier accepts both RS256 (new) and HS256 (legacy) during cutover')
    .pattern('dag')
    .channel('wf-relayauth-121')
    .maxConcurrency(4)
    .timeout(2_400_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Lead, synthesize, drive', cwd: RELAYAUTH })
    .agent('implementer', { cli: 'codex', preset: 'worker', role: 'Implement dual-verify, write tests', cwd: RELAYAUTH })
    .agent('crypto-reviewer', { cli: 'claude', preset: 'reviewer', role: 'Verifier soundness: alg confusion, kid binding, JWKS caching, downgrade attacks', cwd: RELAYAUTH })
    .agent('compat-reviewer', { cli: 'claude', preset: 'reviewer', role: 'Backwards compatibility: existing consumers using old TokenVerifier API must not break', cwd: RELAYAUTH })

    .step('read-spec', { type: 'deterministic', command: `cat ${RELAYAUTH}/specs/api-keys-and-rs256-migration.md ${RELAYAUTH}/specs/token-format.md`, captureOutput: true })

    .step('read-verifier', { type: 'deterministic', command: `cat ${RELAYAUTH}/packages/sdk/src/verify.ts`, captureOutput: true })

    .step('read-tests', { type: 'deterministic', command: `cat ${RELAYAUTH}/packages/sdk/src/__tests__/verify.test.ts 2>/dev/null || echo NO_EXISTING_TESTS`, captureOutput: true })

    .step('write-tests', {
      agent: 'implementer',
      dependsOn: ['read-spec', 'read-verifier', 'read-tests'],
      task: `Write failing tests at ${RELAYAUTH}/packages/sdk/src/__tests__/verify-dual-alg.test.ts.

Spec:
{{steps.read-spec.output}}

Verifier:
{{steps.read-verifier.output}}

Required tests:
1. A token signed with RS256 (using a key matching a JWK in the served JWKS) verifies and returns the correct claims. (current behavior — should not regress)
2. A token signed with HS256 (using the symmetric key) ALSO verifies when the JWKS document includes both an RS256 entry AND an HS256 entry (with the symmetric key material exposed via a documented JWK shape OR via an env-passed verification key — see open question in spec).
3. Alg confusion attack: a token claiming alg=HS256 but with a JWKS that only has an RS256 key for the matching kid is REJECTED. The verifier must enforce header.alg matches the JWK's algorithm.
4. Downgrade attack: a token claiming alg=none is REJECTED.
5. Tampering: payload mutation invalidates either signature.
6. Kid pinning: header.kid must reference a key actually in the JWKS; missing kid → reject.
7. After Phase 3 sunset (HS256 dropped from accept list via env flag RELAYAUTH_VERIFIER_ACCEPT_HS256=false), HS256 tokens are rejected.

Use vitest or whatever the @relayauth/sdk package uses (check package.json).`,
      verification: { type: 'exit_code' },
    })

    .step('verify-tests', { type: 'deterministic', dependsOn: ['write-tests'], command: `test -f ${RELAYAUTH}/packages/sdk/src/__tests__/verify-dual-alg.test.ts && echo OK || (echo MISSING; exit 1)`, captureOutput: true })

    .step('implement', {
      agent: 'implementer',
      dependsOn: ['verify-tests'],
      task: `Update ${RELAYAUTH}/packages/sdk/src/verify.ts to accept both RS256 and HS256.

Changes:
1. resolveVerificationAlgorithm now returns:
   - "RS256" → { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } (existing)
   - "EdDSA" → { name: "Ed25519" } (existing)
   - "HS256" → { name: "HMAC", hash: "SHA-256" } (new, gated on RELAYAUTH_VERIFIER_ACCEPT_HS256 != "false"; default accept)
2. importVerificationKey for HS256 reads the symmetric key bytes from the JWK's "k" field (RFC 7518). The JWK shape RelayAuth needs to start publishing for HS256 includes "k" as base64url of the secret. (See spec open question — confirm with cloud-side JWKS PR.)
3. _verifySignature for HS256 uses crypto.subtle.verify("HMAC", key, sig, signingInput) — same shape as RSA path.
4. Header.alg MUST match the JWK's algorithm at the matching kid. Reject mismatches with invalidTokenError. (Alg confusion mitigation.)
5. Reject alg=none unconditionally (it's not in resolveVerificationAlgorithm — confirm the path).
6. Add env flag RELAYAUTH_VERIFIER_ACCEPT_HS256: when "false", HS256 path is disabled even if the JWKS publishes it.

Backwards compatibility: existing TokenVerifier API surface unchanged. New behavior is purely additive.`,
      verification: { type: 'exit_code' },
    })

    .step('self-review', {
      agent: 'implementer',
      dependsOn: ['implement'],
      task: `Self-review ${RELAYAUTH}/packages/sdk/src/verify.ts.

Walk through:
1. Alg confusion — if a token says HS256 and the JWKS has an RS256 key at the same kid, the code must NOT use the RSA public material as an HMAC key. Confirm the alg check happens BEFORE key import.
2. Header.alg taken from token header (untrusted) — but actual verification uses the JWK's algorithm. Mismatch → reject.
3. JWKS caching — if the verifier caches JWKS for N seconds, the dual-publication of RS256 + HS256 must both fit in the cache.
4. Tests cover the alg-confusion attack vector explicitly.
5. The new env flag has a sensible default (accept HS256 by default during transition; ops flips to "false" after sunset).

End with "self-review clean" or P0/P1 list.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests', { type: 'deterministic', dependsOn: ['self-review'], command: `cd ${RELAYAUTH} && npx vitest run packages/sdk/src/__tests__/verify-dual-alg.test.ts 2>&1 | tail -40; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('typecheck', { type: 'deterministic', dependsOn: ['run-tests'], command: `cd ${RELAYAUTH} && npx turbo typecheck --filter=@relayauth/sdk 2>&1 | tail -30; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('crypto-review', {
      agent: 'crypto-reviewer',
      dependsOn: ['run-tests', 'typecheck'],
      task: `CRYPTO review of dual-verify.

Specifically attack-test the implementation. For each, can you make the verifier accept a token it shouldn't?

1. Alg confusion (RS256 → HS256): construct a token with header.alg=HS256, signature computed by HMAC over the RSA public key bytes. Does the verifier import the public key as an HMAC key and accept? If yes — P0 ship-blocker.
2. Alg=none injection: header.alg=none, no signature. Rejected?
3. Kid spoofing: header.kid points to a key that doesn't match the actual signature. Rejected?
4. JWK material confusion: a JWK with kty=RSA but a "k" field — does the HS256 path try to use it? Must reject (kty + alg must agree).
5. Algorithm enum: any unbounded "if alg.startsWith('RS')" patterns that could match unintended values?

Output: VERDICT, BLOCKING_ISSUES, ADVISORY.

Tests + typecheck:
{{steps.run-tests.output}}
{{steps.typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('compat-review', {
      agent: 'compat-reviewer',
      dependsOn: ['run-tests', 'typecheck'],
      task: `Backwards-compat review.

Read the public TokenVerifier surface (.d.ts):
- Constructor signature unchanged?
- verify() / verifyAndCheckScope() / verifyOrNull() signatures unchanged?
- Return types unchanged?
- Any thrown error types changed?

Read sage's TokenVerifier usage (sibling repo, look at sage/node_modules/@relayauth/sdk consumer code) — would the new SDK version drop into sage without code changes?

Output: VERDICT, breaking changes (if any), required-consumer-updates.`,
      verification: { type: 'exit_code' },
    })

    .step('synthesize', { agent: 'architect', dependsOn: ['crypto-review', 'compat-review', 'self-review'], task: `Synthesize. Self: {{steps.self-review.output}}\nCrypto: {{steps.crypto-review.output}}\nCompat: {{steps.compat-review.output}}\n\nP0+P1 in. Conflicts: explain decision. "no-fixes-needed" if clean.`, verification: { type: 'exit_code' } })

    .step('fix', { agent: 'implementer', dependsOn: ['synthesize'], task: `Apply: {{steps.synthesize.output}}`, verification: { type: 'exit_code' } })

    .step('rerun-tests', { type: 'deterministic', dependsOn: ['fix'], command: `cd ${RELAYAUTH} && npx vitest run packages/sdk/src/__tests__/verify-dual-alg.test.ts 2>&1 | tail -40; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('rerun-typecheck', { type: 'deterministic', dependsOn: ['rerun-tests'], command: `cd ${RELAYAUTH} && npx turbo typecheck --filter=@relayauth/sdk 2>&1 | tail -30; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('crypto-reapproval', { agent: 'crypto-reviewer', dependsOn: ['rerun-tests', 'rerun-typecheck'], task: `Re-attack the patched verifier. VERDICT + unresolved.\n\nTests: {{steps.rerun-tests.output}}\nTypecheck: {{steps.rerun-typecheck.output}}`, verification: { type: 'exit_code' } })

    .step('compat-reapproval', { agent: 'compat-reviewer', dependsOn: ['rerun-tests', 'rerun-typecheck'], task: `Re-review compat. VERDICT + breaking changes.`, verification: { type: 'exit_code' } })

    .step('approval-gate', {
      agent: 'architect',
      dependsOn: ['crypto-reapproval', 'compat-reapproval'],
      task: `Crypto: {{steps.crypto-reapproval.output}}\nCompat: {{steps.compat-reapproval.output}}\nTests: {{steps.rerun-tests.output}}\nTypecheck: {{steps.rerun-typecheck.output}}\n\nHard pass — ALL true:\n- crypto verdict approve\n- compat verdict approve (no breaking changes)\n- tests EXIT 0\n- typecheck EXIT 0\n\n"PHASE 3A APPROVED" exit 0 OR "PHASE 3A REJECTED" + failures exit 1.`,
      verification: { type: 'exit_code' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: RELAYAUTH, onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()) });

  console.log(`\n121 sdk-dual-verify phase 3a: ${result.status}`);
}

main().catch(console.error);
