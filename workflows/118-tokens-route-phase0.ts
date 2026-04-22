/**
 * 118-tokens-route-phase0.ts
 *
 * spec: specs/api-keys-and-rs256-migration.md (Phase 0)
 *
 * Implements `POST /v1/tokens` (and `/refresh`, `/revoke`, `/introspect`).
 * The discovery endpoint and SDK already point at this route; production
 * returns 404 today. This workflow brings the implementation in line with
 * what every other piece of the system already assumes exists.
 *
 * Review model — applied to every workflow in this migration series:
 *
 *   1. Implementer writes code + tests.
 *   2. Implementer self-reviews the diff (catches obvious issues before
 *      handoff; cheaper than burning a reviewer turn on lint-level finds).
 *   3. Two parallel specialist reviewers run, each with a single lens:
 *      - security-reviewer: auth/crypto correctness, no token leakage,
 *        no input validation gaps, no privilege escalation.
 *      - spec-reviewer: conformance with specs/token-format.md,
 *        specs/openapi.yaml, error catalog, claim shapes.
 *   4. Architect synthesizes both reviews into a fix list. Empty list ⇒
 *      pass through. Non-empty ⇒ implementer fixes, tests + typecheck
 *      re-run.
 *   5. Approval gate: re-runs both specialist reviewers on the patched
 *      code; workflow fails if either still flags blocking issues.
 *
 * Run: agent-relay run workflows/118-tokens-route-phase0.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
  const result = await workflow('118-tokens-route-phase0')
    .description('Implement POST /v1/tokens, /refresh, /revoke, /introspect with strict review')
    .pattern('dag')
    .channel('wf-relayauth-118')
    .maxConcurrency(4)
    .timeout(2_400_000)

    .agent('architect', {
      cli: 'claude',
      preset: 'lead',
      role: 'Lead the implementation, synthesize reviews, drive fixes',
      cwd: ROOT,
    })
    .agent('implementer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Write tests, write production code, fix issues from reviews',
      cwd: ROOT,
    })
    .agent('security-reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Auth/crypto correctness, token leakage, privilege escalation, input validation',
      cwd: ROOT,
    })
    .agent('spec-reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Conformance with token-format.md, openapi.yaml, error catalog, claim shapes',
      cwd: ROOT,
    })

    // ── Phase A: Read context ──────────────────────────────────────────

    .step('read-migration-spec', {
      type: 'deterministic',
      command: `cat ${ROOT}/specs/api-keys-and-rs256-migration.md`,
      captureOutput: true,
    })

    .step('read-token-format', {
      type: 'deterministic',
      command: `cat ${ROOT}/specs/token-format.md`,
      captureOutput: true,
    })

    .step('read-openapi', {
      type: 'deterministic',
      command: `cat ${ROOT}/specs/openapi.yaml`,
      captureOutput: true,
    })

    .step('read-server-routes', {
      type: 'deterministic',
      command: `cd ${ROOT} && cat packages/server/src/server.ts && echo '--- existing identities route ---' && cat packages/server/src/routes/identities.ts`,
      captureOutput: true,
    })

    .step('read-storage-interfaces', {
      type: 'deterministic',
      command: `cat ${ROOT}/packages/server/src/storage/interface.ts`,
      captureOutput: true,
    })

    .step('read-existing-jwt-helpers', {
      type: 'deterministic',
      command: `cd ${ROOT} && find packages/server/src -name '*.ts' -path '*jwt*' -not -path '*test*' -exec echo '=== {} ===' \\; -exec cat {} \\;`,
      captureOutput: true,
    })

    .step('read-types', {
      type: 'deterministic',
      command: `cat ${ROOT}/packages/types/src/token.ts 2>/dev/null || echo 'NO TOKEN TYPES FILE'`,
      captureOutput: true,
    })

    // ── Phase B: Tests first ───────────────────────────────────────────

    .step('write-tests', {
      agent: 'implementer',
      dependsOn: ['read-migration-spec', 'read-token-format', 'read-openapi', 'read-storage-interfaces', 'read-existing-jwt-helpers', 'read-types'],
      task: `Write failing tests at ${ROOT}/packages/server/src/__tests__/tokens-route.test.ts.

Migration spec (Phase 0 only):
{{steps.read-migration-spec.output}}

Token format spec (claims, signing, JWKS rules — your tests must enforce these):
{{steps.read-token-format.output}}

OpenAPI surface for /v1/tokens routes:
{{steps.read-openapi.output}}

Existing routes pattern to match:
{{steps.read-server-routes.output}}

Storage interfaces (you can add to TokenStorage if needed):
{{steps.read-storage-interfaces.output}}

Existing JWT helpers:
{{steps.read-existing-jwt-helpers.output}}

Token types:
{{steps.read-types.output}}

Cover the four routes (POST /v1/tokens, POST /refresh, POST /revoke, GET /introspect).
For each: happy path + at least three failure modes (missing auth, malformed input,
expired/revoked token where applicable). Assert claim shape matches token-format.md
exactly. Reject HS256 verification in tests if Phase 2 has not landed yet — use the
existing HS256 path for now, but the test names should make the algorithm explicit so
the Phase 2 swap is visible.

Use node:test + node:assert/strict (match repo convention).`,
      verification: { type: 'exit_code' },
    })

    .step('verify-tests-exist', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: `test -f ${ROOT}/packages/server/src/__tests__/tokens-route.test.ts && echo OK || (echo MISSING; exit 1)`,
      captureOutput: true,
    })

    .step('run-tests-pre-impl', {
      type: 'deterministic',
      dependsOn: ['verify-tests-exist'],
      command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/tokens-route.test.ts 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase C: Implement ─────────────────────────────────────────────

    .step('implement-tokens-route', {
      agent: 'implementer',
      dependsOn: ['run-tests-pre-impl'],
      task: `Implement the four /v1/tokens routes so the tests pass.

Failing test output (these are the contracts you must satisfy):
{{steps.run-tests-pre-impl.output}}

Test source for reference:
${ROOT}/packages/server/src/__tests__/tokens-route.test.ts

Existing routes pattern:
{{steps.read-server-routes.output}}

Existing JWT helpers (reuse signHs256 + claims builder; do NOT introduce RS256 here — that's Phase 2):
{{steps.read-existing-jwt-helpers.output}}

Required files:
1. ${ROOT}/packages/server/src/routes/tokens.ts — Hono router with the 4 routes.
2. Wire into ${ROOT}/packages/server/src/server.ts: app.route("/v1/tokens", tokens).
3. Persist issued tokens in the existing tokens table (jti, identity_id, issued_at, expires_at, status).
4. Use authenticateAndAuthorize from lib/auth.ts for bearer auth on POST /v1/tokens.
5. POST /v1/tokens/revoke must mark status='revoked' in tokens table AND write to RevocationStorage.

Do NOT change crypto algorithm. Do NOT add API-key auth (Phase 1). Stay minimal.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['implement-tokens-route'],
      command: `test -f ${ROOT}/packages/server/src/routes/tokens.ts && grep -q 'app.route."/v1/tokens"' ${ROOT}/packages/server/src/server.ts && echo OK || (echo MISSING_OR_NOT_REGISTERED; exit 1)`,
      captureOutput: true,
    })

    // ── Phase D: Self-review ───────────────────────────────────────────

    .step('self-review', {
      agent: 'implementer',
      dependsOn: ['verify-files'],
      task: `Self-review your implementation BEFORE handing off to peer reviewers.

Read the diff you just produced:
- ${ROOT}/packages/server/src/routes/tokens.ts
- ${ROOT}/packages/server/src/server.ts
- ${ROOT}/packages/server/src/__tests__/tokens-route.test.ts
- any storage/interface changes

For each route, walk through:
1. Authentication: who can call it? Is the check actually invoked on the route? Could a misformed Authorization header bypass it?
2. Input validation: every required field rejected if missing, every string length-bounded, every number range-checked?
3. Error responses: do they match the existing error-catalog format used by the identities route? Do error bodies leak any internal state (token values, internal IDs not yet observed by the caller, stack traces)?
4. Persistence: is the token row written BEFORE the response is returned (so a crash mid-write doesn't issue a token without revocation hook)?
5. Audit: does every issuance and revocation write to AuditStorage with the right action name?
6. Type narrowing: any 'as any' casts? Any unchecked optional accesses?

List every issue you find with severity P0/P1/P2 and a one-line proposed fix. If you find P0 issues, fix them now and re-list. If clean, write "self-review clean" as the last line of your output.`,
      verification: { type: 'exit_code' },
    })

    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/tokens-route.test.ts 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['run-tests'],
      command: `cd ${ROOT} && npx turbo typecheck --filter=@relayauth/server 2>&1 | tail -30; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase E: Specialist peer reviews (parallel) ────────────────────

    .step('security-review', {
      agent: 'security-reviewer',
      dependsOn: ['run-tests', 'typecheck'],
      task: `Security review of the /v1/tokens implementation.

Focus exclusively on auth, crypto, input handling, and information leakage. Out of scope: spec conformance, code style, test naming.

Read every file the implementer changed. For each route, answer:
1. Can an unauthenticated caller obtain a token? (POST /v1/tokens, /refresh)
2. Can a token holder escalate their scopes? (must be subset of identity's granted scopes)
3. Is the JWT signed with the documented algorithm only? (HS256 today; reject any other alg in the verifier)
4. Does the implementation log or echo plaintext tokens anywhere? (audit metadata, error bodies, console.log)
5. Are jti / sid values generated with crypto-grade entropy?
6. POST /v1/tokens/revoke: is the caller authorised to revoke this specific token? (token owner OR admin scope)
7. GET /v1/tokens/introspect: does it leak claims for tokens the caller cannot see?
8. Timing: any string comparisons of secrets without constant-time? (Bearer scheme parse, jti lookup, etc.)

Output format:
- BLOCKING_ISSUES: list with severity P0 (ship-blocker) or P1 (must-fix-soon)
- ADVISORY: P2/P3 issues
- VERDICT: "approve" or "request-changes"

Tests + typecheck output for context:
{{steps.run-tests.output}}
{{steps.typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('spec-review', {
      agent: 'spec-reviewer',
      dependsOn: ['run-tests', 'typecheck'],
      task: `Spec-conformance review of the /v1/tokens implementation.

Focus exclusively on whether the routes match the documented contracts. Out of scope: security depth (security-reviewer covers it), code style.

Specs to enforce:
- ${ROOT}/specs/token-format.md (claim shape, JWT header, signing algorithms)
- ${ROOT}/specs/openapi.yaml (route paths, request/response shapes, status codes)
- ${ROOT}/specs/error-catalog.md if present (error code + message format)

For each of the four routes, answer:
1. Does the URL path match the OpenAPI spec exactly?
2. Does the request body validation accept exactly the documented shape (no extra required fields, no missing required fields)?
3. Does the response shape match (TokenPair, RevocationResponse, IntrospectionResponse)?
4. Are status codes correct? (201 for create, 200 for read/revoke, 401/403/404/410 per spec)
5. Are error responses { error, code, status } structured per the error catalog?
6. Do issued claims match token-format.md exactly: required claims (sub, org, wks, scopes, sponsorId, sponsorChain, iss, aud, iat, exp, jti, token_type)?
7. Are TTLs within the bounds documented in token-format.md (no permanent tokens, max 30 days)?

Output format:
- BLOCKING_ISSUES: severity P0/P1
- ADVISORY: P2/P3
- VERDICT: "approve" or "request-changes"`,
      verification: { type: 'exit_code' },
    })

    // ── Phase F: Synthesize + Fix ──────────────────────────────────────

    .step('synthesize-reviews', {
      agent: 'architect',
      dependsOn: ['security-review', 'spec-review', 'self-review'],
      task: `Synthesize all three reviews into a single prioritised fix list.

Self-review:
{{steps.self-review.output}}

Security review:
{{steps.security-review.output}}

Spec-conformance review:
{{steps.spec-review.output}}

Build a single ordered fix list:
1. Every P0 from any reviewer goes in (ship-blockers).
2. Every P1 goes in.
3. P2 only if it's a one-liner; otherwise defer to a followup with a TODO comment in the code citing this workflow.
4. Conflicts between reviewers (e.g. security says X, spec says ¬X): you decide and explain.

If both reviewers say "approve" and self-review was clean, output "no-fixes-needed" and the fix step will short-circuit.`,
      verification: { type: 'exit_code' },
    })

    .step('fix-issues', {
      agent: 'implementer',
      dependsOn: ['synthesize-reviews'],
      task: `Apply the prioritised fix list from the architect's synthesis.

Fix list:
{{steps.synthesize-reviews.output}}

If the synthesis output is "no-fixes-needed", do nothing and write "skipped" to stdout.

Otherwise: implement every P0 + P1 + agreed P2. Re-run tests after each significant change. Add a one-line comment for any deferred P2/P3 referencing this workflow.`,
      verification: { type: 'exit_code' },
    })

    .step('rerun-tests', {
      type: 'deterministic',
      dependsOn: ['fix-issues'],
      command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/tokens-route.test.ts 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('rerun-typecheck', {
      type: 'deterministic',
      dependsOn: ['rerun-tests'],
      command: `cd ${ROOT} && npx turbo typecheck --filter=@relayauth/server 2>&1 | tail -30; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase G: Approval gate (re-review the patched code) ────────────

    .step('security-reapproval', {
      agent: 'security-reviewer',
      dependsOn: ['rerun-tests', 'rerun-typecheck'],
      task: `Re-review for security after fixes. Same scope as before. Output:
- VERDICT: "approve" or "still-blocking"
- If still-blocking, list the unresolved P0/P1 issues.

Tests + typecheck:
{{steps.rerun-tests.output}}
{{steps.rerun-typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('spec-reapproval', {
      agent: 'spec-reviewer',
      dependsOn: ['rerun-tests', 'rerun-typecheck'],
      task: `Re-review for spec-conformance after fixes. Same scope as before. Output:
- VERDICT: "approve" or "still-blocking"
- If still-blocking, list the unresolved P0/P1 issues.

Tests + typecheck:
{{steps.rerun-tests.output}}
{{steps.rerun-typecheck.output}}`,
      verification: { type: 'exit_code' },
    })

    .step('approval-gate', {
      agent: 'architect',
      dependsOn: ['security-reapproval', 'spec-reapproval'],
      task: `Approval gate.

Security verdict:
{{steps.security-reapproval.output}}

Spec-conformance verdict:
{{steps.spec-reapproval.output}}

Tests output:
{{steps.rerun-tests.output}}

Typecheck output:
{{steps.rerun-typecheck.output}}

Hard pass criteria — ALL must be true:
- security-reviewer verdict is "approve"
- spec-reviewer verdict is "approve"
- tests EXIT: 0
- typecheck EXIT: 0

If all true, write "PHASE 0 APPROVED" and exit 0.
If any are false, write "PHASE 0 REJECTED" followed by the specific failures, and exit 1.`,
      verification: { type: 'exit_code' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({
      cwd: ROOT,
      onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
    });

  console.log(`\n118 tokens-route phase 0: ${result.status}`);
}

main().catch(console.error);
