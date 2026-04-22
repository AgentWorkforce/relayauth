/**
 * 120-rs256-signing-phase2a.ts
 *
 * spec: specs/api-keys-and-rs256-migration.md (Phase 2 — relayauth side)
 * depends on: 118 (tokens route exists), 119 (api keys exist)
 *
 * Adds RS256 signing as an OPTION alongside existing HS256. Does NOT cut
 * over by default — that lands in 121. Adds:
 *   - lib/sign-rs256.ts (Web Crypto subtle-key import + sign)
 *   - lib/sign.ts dispatcher: chooses signer by RELAYAUTH_SIGNING_ALG env
 *     (defaults to "HS256" — no behavior change)
 *   - JWKS endpoint serves both the existing HS256 metadata AND, when
 *     RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is set, an RSA public JWK
 *
 * Same review model as 118/119. Crypto changes get extra-strict security
 * review.
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
  const result = await workflow('120-rs256-signing-phase2a')
    .description('Add RS256 signing path + JWKS RSA publication; HS256 stays default')
    .pattern('dag')
    .channel('wf-relayauth-120')
    .maxConcurrency(4)
    .timeout(2_400_000)

    .agent('architect', { cli: 'claude', preset: 'lead', role: 'Lead crypto changes, synthesize reviews', cwd: RELAYAUTH })
    .agent('implementer', { cli: 'codex', preset: 'worker', role: 'Implement signing + JWKS, write tests', cwd: RELAYAUTH })
    .agent('crypto-reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'CRYPTO review: key handling, never-leak-private, JWK shape, kid stability, sign-then-verify roundtrip soundness',
      cwd: RELAYAUTH,
    })
    .agent('spec-reviewer', { cli: 'claude', preset: 'reviewer', role: 'token-format.md + JWKS spec conformance', cwd: RELAYAUTH })

    .step('read-spec', { type: 'deterministic', command: `cat ${RELAYAUTH}/specs/api-keys-and-rs256-migration.md ${RELAYAUTH}/specs/token-format.md`, captureOutput: true })

    .step('read-existing-sign', { type: 'deterministic', command: `cd ${RELAYAUTH} && find packages/server/src -name '*.ts' -path '*sign*' -o -name '*jwks*' -not -path '*test*' -exec echo === {} === \\; -exec cat {} \\;`, captureOutput: true })

    .step('write-tests', {
      agent: 'implementer',
      dependsOn: ['read-spec', 'read-existing-sign'],
      task: `Write failing tests at ${RELAYAUTH}/packages/server/src/__tests__/sign-rs256.test.ts and jwks-rsa.test.ts.

Spec:
{{steps.read-spec.output}}

Existing signing code:
{{steps.read-existing-sign.output}}

Required tests:
1. signRs256(claims, privateKeyPem, kid) returns a 3-part JWT, header.alg=RS256, header.kid matches.
2. The token verifies cleanly via @relayauth/sdk's TokenVerifier against a JWKS document containing the matching RSA public key.
3. Tampered payload fails verification.
4. The JWKS endpoint, when RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is set, returns an RSA JWK with kty=RSA, n, e, kid, use=sig, alg=RS256 — and NEVER includes "d" (private exponent).
5. The JWKS endpoint when RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is unset returns the existing HS256 metadata (no behavior change).
6. The JWKS endpoint when both are set returns BOTH entries (transition window).
7. The dispatcher in lib/sign.ts uses RS256 when RELAYAUTH_SIGNING_ALG=RS256 + the private key env is set; uses HS256 otherwise.

Use node:test + node:assert/strict.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-tests', { type: 'deterministic', dependsOn: ['write-tests'], command: `test -f ${RELAYAUTH}/packages/server/src/__tests__/sign-rs256.test.ts && test -f ${RELAYAUTH}/packages/server/src/__tests__/jwks-rsa.test.ts && echo OK || (echo MISSING; exit 1)`, captureOutput: true })

    .step('implement', {
      agent: 'implementer',
      dependsOn: ['verify-tests'],
      task: `Implement the signing + JWKS changes.

Files:
1. ${RELAYAUTH}/packages/server/src/lib/sign-rs256.ts:
   - importRsaPrivateKey(pem) using crypto.subtle.importKey with PKCS8
   - signRs256(claims, key, kid) → JWT string
   - keyIdFromPublicJwk(jwk) → SHA-256 fingerprint, first 8 hex chars; format: "<env-stage>-<yyyy-mm>-<hash8>"
2. ${RELAYAUTH}/packages/server/src/lib/sign.ts:
   - signToken(claims, env) — dispatcher. Reads RELAYAUTH_SIGNING_ALG (default HS256). For RS256, requires RELAYAUTH_SIGNING_KEY_PEM env; throws clear error if unset.
3. ${RELAYAUTH}/packages/server/src/lib/jwk.ts:
   - rsaPublicJwkFromPem(publicPem, kid) → RSA JWK with n, e, kid, use, alg
4. ${RELAYAUTH}/packages/server/src/routes/jwks.ts (modify):
   - When env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is set, include the RSA JWK alongside any existing keys
   - Never include "d" or any private material
5. Update existing token-issuance to call signToken(claims, env) instead of the direct HS256 helper. Behavior unchanged (HS256 default).

DO NOT remove HS256. DO NOT change the default. This phase is additive.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-files', { type: 'deterministic', dependsOn: ['implement'], command: `test -f ${RELAYAUTH}/packages/server/src/lib/sign-rs256.ts && test -f ${RELAYAUTH}/packages/server/src/lib/sign.ts && test -f ${RELAYAUTH}/packages/server/src/lib/jwk.ts && echo OK || (echo MISSING; exit 1)`, captureOutput: true })

    .step('self-review', {
      agent: 'implementer',
      dependsOn: ['verify-files'],
      task: `Self-review every file you changed. Specifically check:
1. The private key PEM is read from env ONCE at sign time, never logged, never serialized.
2. importKey is called with extractable=false so the key cannot be exported back out.
3. JWKS response NEVER contains a "d" field (private exponent). Grep confirms.
4. The dispatcher rejects unknown alg values with a clear error rather than silently falling through.
5. Tests cover the JWKS dual-publication case (HS256 + RS256 simultaneously).

End with "self-review clean" or list P0/P1 issues with fix proposals.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests', { type: 'deterministic', dependsOn: ['self-review'], command: `cd ${RELAYAUTH} && node --test --import tsx packages/server/src/__tests__/sign-rs256.test.ts packages/server/src/__tests__/jwks-rsa.test.ts 2>&1 | tail -40; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('typecheck', { type: 'deterministic', dependsOn: ['run-tests'], command: `cd ${RELAYAUTH} && npx turbo typecheck --filter=@relayauth/server 2>&1 | tail -30; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('crypto-review', {
      agent: 'crypto-reviewer',
      dependsOn: ['run-tests', 'typecheck'],
      task: `CRYPTO review of the RS256 + JWKS changes.

This is the strictest review tier — production cryptographic correctness. Read every line of:
- lib/sign-rs256.ts
- lib/sign.ts
- lib/jwk.ts
- routes/jwks.ts (modified)

For each, answer:
1. Key import — uses extractable=false, correct algorithm, correct usages array (["sign"] only)?
2. Sign path — correct format (RSASSA-PKCS1-v1_5 / SHA-256)? base64url encoding correct? signature length matches RSA modulus?
3. Header — alg=RS256 (not RS512 or PS256), kid included, typ=JWT?
4. Payload — same claim builder used as HS256 path (no divergence)?
5. JWKS shape — kty=RSA, n + e present, NO d/p/q/dp/dq/qi (private fields)? alg matches the signing alg? kid stable across invocations?
6. Dual publication — when both HS256 + RS256 keys present, the JWKS entries don't share a kid?
7. Error path — does any error message echo the private key bytes back? Any stack trace that includes the PEM string?
8. Roundtrip — does a token signed by signRs256 verify cleanly via @relayauth/sdk's TokenVerifier with the published JWKS? Tests should prove this.

Output: VERDICT (approve / request-changes), BLOCKING_ISSUES, ADVISORY.

Tests + typecheck:
{{steps.run-tests.output}}
{{steps.typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('spec-review', {
      agent: 'spec-reviewer',
      dependsOn: ['run-tests', 'typecheck'],
      task: `Spec-conformance review against token-format.md and the JWKS contract.

Read modified files. Confirm:
1. Token header matches token-format.md exactly: { alg: "RS256", typ: "JWT", kid }.
2. Claim shape unchanged from HS256 path (this phase doesn't change claims).
3. JWKS response is { keys: [<jwk>...] } with each JWK matching the JWK spec for its kty.
4. kid format follows the convention in token-format.md (or the migration spec if it overrides).

Output: VERDICT + issues.`,
      verification: { type: 'exit_code' },
    })

    .step('synthesize', { agent: 'architect', dependsOn: ['crypto-review', 'spec-review', 'self-review'], task: `Synthesize fix list. Self: {{steps.self-review.output}}\nCrypto: {{steps.crypto-review.output}}\nSpec: {{steps.spec-review.output}}\n\nP0 + P1 in. P2 only if one-liner. "no-fixes-needed" if all clear.`, verification: { type: 'exit_code' } })

    .step('fix', { agent: 'implementer', dependsOn: ['synthesize'], task: `Apply: {{steps.synthesize.output}}\n\nIf "no-fixes-needed", write "skipped".`, verification: { type: 'exit_code' } })

    .step('rerun-tests', { type: 'deterministic', dependsOn: ['fix'], command: `cd ${RELAYAUTH} && node --test --import tsx packages/server/src/__tests__/sign-rs256.test.ts packages/server/src/__tests__/jwks-rsa.test.ts 2>&1 | tail -40; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('rerun-typecheck', { type: 'deterministic', dependsOn: ['rerun-tests'], command: `cd ${RELAYAUTH} && npx turbo typecheck --filter=@relayauth/server 2>&1 | tail -30; echo "EXIT: $?"`, captureOutput: true, failOnError: false })

    .step('crypto-reapproval', { agent: 'crypto-reviewer', dependsOn: ['rerun-tests', 'rerun-typecheck'], task: `Re-review crypto. VERDICT (approve / still-blocking) + unresolved issues.\n\nTests: {{steps.rerun-tests.output}}\nTypecheck: {{steps.rerun-typecheck.output}}`, verification: { type: 'exit_code' } })

    .step('spec-reapproval', { agent: 'spec-reviewer', dependsOn: ['rerun-tests', 'rerun-typecheck'], task: `Re-review spec. VERDICT + unresolved.`, verification: { type: 'exit_code' } })

    .step('approval-gate', {
      agent: 'architect',
      dependsOn: ['crypto-reapproval', 'spec-reapproval'],
      task: `Approval gate.

Crypto: {{steps.crypto-reapproval.output}}
Spec: {{steps.spec-reapproval.output}}
Tests: {{steps.rerun-tests.output}}
Typecheck: {{steps.rerun-typecheck.output}}

Hard pass — ALL true:
- crypto verdict "approve"
- spec verdict "approve"
- tests EXIT: 0
- typecheck EXIT: 0

If all true: "PHASE 2A APPROVED" exit 0. Else: "PHASE 2A REJECTED" + failures, exit 1.`,
      verification: { type: 'exit_code' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: RELAYAUTH, onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()) });

  console.log(`\n120 rs256-signing phase 2a: ${result.status}`);
}

main().catch(console.error);
