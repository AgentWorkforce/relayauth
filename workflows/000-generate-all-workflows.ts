/**
 * 000-generate-all-workflows.ts
 *
 * Meta-workflow: reads the workflow manifest and generates all 100
 * workflow files with full detail — TDD, claude leads, codex implementers,
 * proper swarm patterns, verification gates, and step output chaining.
 *
 * Each generated workflow follows the writing-agent-relay-workflows skill:
 *   - Claude leads for architecture/review/integration
 *   - Codex workers (preset: worker) for implementation
 *   - Deterministic steps for file reads, verification gates
 *   - Pre-inject content via {{steps.X.output}}, never ask agents to discover
 *   - exit_code verification for code-editing workers
 *   - 3-4 phases max per workflow
 *   - maxConcurrency: 4-5
 *   - File materialization checks after every implementation wave
 *
 * Run: agent-relay run workflows/000-generate-all-workflows.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('000-generate-all-workflows')
  .description('Generate all 100 relayauth workflows from the manifest')
  .pattern('dag')
  .channel('wf-relayauth-gen')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('workflow-architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design workflow structure, review generated workflows for correctness',
    cwd: ROOT,
  })
  .agent('domain-1-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 1 (Foundation) workflows 002-010',
    cwd: ROOT,
  })
  .agent('domain-2-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 2 (Token System) workflows 011-020',
    cwd: ROOT,
  })
  .agent('domain-3-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 3 (Identity Lifecycle) workflows 021-030',
    cwd: ROOT,
  })
  .agent('domain-4-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 4 (Scopes & RBAC) workflows 031-040',
    cwd: ROOT,
  })
  .agent('domain-5-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 5 (API Routes) workflows 041-050',
    cwd: ROOT,
  })
  .agent('domain-6-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 6 (Audit) workflows 051-058',
    cwd: ROOT,
  })
  .agent('domain-7-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 7 (SDK) workflows 059-068',
    cwd: ROOT,
  })
  .agent('domain-8-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 8 (CLI) workflows 069-075',
    cwd: ROOT,
  })
  .agent('domain-9-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 9 (Integration) workflows 076-082',
    cwd: ROOT,
  })
  .agent('domain-10-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domain 10 (Hosted Server) workflows 083-090',
    cwd: ROOT,
  })
  .agent('domain-11-12-gen', {
    cli: 'claude',
    preset: 'worker',
    role: 'Generate Domains 11-12 (Testing/CI/Docs) workflows 091-100',
    cwd: ROOT,
  })

  // ── Phase 1: Read context ──────────────────────────────────────────

  .step('read-manifest', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/workflow-manifest.md`,
    captureOutput: true,
  })

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-example-workflow', {
    type: 'deterministic',
    command: `cat ${ROOT}/workflows/001-project-scaffold.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-e2e', {
    type: 'deterministic',
    command: `head -100 ${RELAYCAST}/scripts/e2e.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-test-helpers', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  // ── Phase 2: Architect creates the generation template ─────────────

  .step('create-template', {
    agent: 'workflow-architect',
    dependsOn: ['read-manifest', 'read-architecture', 'read-example-workflow'],
    task: `Create the workflow generation guidelines at ${ROOT}/docs/workflow-generation-rules.md.

This document is THE reference for all workflow generators. It must be extremely detailed.

Manifest:
{{steps.read-manifest.output}}

Architecture:
{{steps.read-architecture.output}}

Example workflow (001):
{{steps.read-example-workflow.output}}

Write rules covering:

**1. File naming and structure:**
- File: workflows/{NNN}-{kebab-name}.ts
- Import: import { workflow } from '@agent-relay/sdk/workflows';
- Wrap in async function main() { ... } main().catch(console.error);
- ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth'
- RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast'
- RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile'

**2. Agent pattern (MANDATORY for every workflow):**
- Claude leads: { cli: 'claude', preset: 'lead', role: '...' }
  Used for: architecture, review, integration, fixing
- Codex workers: { cli: 'codex', preset: 'worker', role: '...' }
  Used for: implementation, writing tests, writing code
- NEVER use codex as lead or claude as worker

**3. TDD structure (MANDATORY for every feature workflow):**
Phase 1: Read existing code + write tests FIRST
  - Deterministic steps read relevant files
  - Test-writer (codex worker) writes failing tests based on the spec
  - Verify test file exists

Phase 2: Implement
  - Implementer (codex worker) writes the code to make tests pass
  - File verification gate (deterministic)

Phase 3: Verify + Fix
  - Run tests (deterministic)
  - Run typecheck (deterministic)
  - Fixer (claude lead) reads failures, fixes, re-runs

**4. Step patterns:**
- ALWAYS pre-read files in deterministic steps, inject via {{steps.X.output}}
- NEVER ask codex workers to discover files themselves
- ALWAYS verify file materialization after implementation steps
- Use exit_code verification for all codex worker steps
- Limit task prompts to 10-20 lines; if larger, use lead+workers team pattern
- maxConcurrency: 4-5
- 3-4 phases max

**5. Test patterns (TDD):**
- Unit tests: packages/server/src/__tests__/{feature}.test.ts
- Use node:test + node:assert/strict
- Test helpers: import from ../test-helpers
- Each test file tests ONE module/feature
- Tests written BEFORE implementation
- E2E test steps at the end of each domain

**6. Dependency management:**
- Each workflow declares which prior workflows it depends on (in the JSDoc comment)
- Workflows within a domain are sequential (011 before 012)
- E2E workflows (020, 030, etc.) depend on all workflows in their domain
- Cross-domain dependencies follow the manifest

**7. Swarm pattern selection (from choosing-swarm-patterns skill):**
- Most workflows: dag (parallel where possible, joins where needed)
- Review workflows: pipeline (analyze → implement → verify)
- E2E workflows: pipeline (setup → test → teardown)
- Large implementation: hub-spoke (lead coordinates workers)

**8. Template for each workflow type:**

Feature workflow template:
  Phase 1: read-* (deterministic) → write-tests (codex worker) → verify-tests-exist
  Phase 2: implement-* (codex workers, parallel) → verify-files
  Phase 3: run-tests (deterministic) → typecheck (deterministic) → fix (claude lead)

E2E workflow template:
  Phase 1: read-* (deterministic) → write-e2e (codex worker) → verify-e2e-exists
  Phase 2: run-e2e (deterministic) → analyze-results (claude lead)

Spec workflow template:
  Phase 1: read-* (deterministic) → write-spec (claude lead/codex worker)
  Phase 2: verify-spec-complete (deterministic)

Write the complete generation rules document.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 3: Generate all domains (parallel) ─────────────────────

  .step('gen-domain-1', {
    agent: 'domain-1-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 002-010 (Domain 1: Foundation).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md
Read the example: cat ${ROOT}/workflows/001-project-scaffold.ts

Generate these workflow files at ${ROOT}/workflows/:

002-openapi-spec.ts — Write the OpenAPI v3 spec for all relayauth endpoints
003-token-format-spec.ts — Define JWT claims, signing algorithms, JWKS format
004-scope-format-spec.ts — Define scope syntax, wildcard matching, path patterns
005-rbac-spec.ts — Define role/policy format, inheritance, evaluation order
006-audit-spec.ts — Define audit log format, retention, query semantics
007-error-catalog.ts — Define all error codes, messages, HTTP status mappings
008-test-helpers-complete.ts — Full test helper suite: mocks, factories, assertions
009-dev-environment.ts — Local dev: wrangler dev, seed data, dev tokens
010-contract-tests.ts — Tests that verify implementation matches OpenAPI spec

Each workflow must:
- Follow the generation rules exactly
- Use claude leads + codex workers
- Include TDD where applicable
- Have proper dependsOn chains
- Include verification gates
- Be wrapped in async function main()

Write ALL 9 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-2', {
    agent: 'domain-2-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 011-020 (Domain 2: Token System).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md
Read the architecture: cat ${ROOT}/specs/architecture.md

Generate these workflow files at ${ROOT}/workflows/:

011-jwt-signing.ts — RS256/EdDSA JWT signing with key rotation
012-jwks-endpoint.ts — GET /.well-known/jwks.json
013-token-verification.ts — Zero-dep JWT verification library (SDK)
014-token-issuance-api.ts — POST /v1/tokens
015-token-refresh-api.ts — POST /v1/tokens/refresh
016-token-revocation-api.ts — POST /v1/tokens/revoke + KV propagation
017-revocation-kv.ts — KV-based revocation list
018-token-introspect-api.ts — GET /v1/tokens/introspect
019-key-rotation.ts — Automated signing key rotation
020-token-system-e2e.ts — E2E: issue → validate → refresh → revoke

TDD for each: write tests first, then implement, then verify.
Each workflow builds on the previous — proper dependsOn chains.

Write ALL 10 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-3', {
    agent: 'domain-3-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 021-030 (Domain 3: Identity Lifecycle).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate these workflow files at ${ROOT}/workflows/:

021-identity-do.ts — IdentityDO durable object
022-create-identity-api.ts — POST /v1/identities
023-get-identity-api.ts — GET /v1/identities/:id
024-list-identities-api.ts — GET /v1/identities
025-update-identity-api.ts — PATCH /v1/identities/:id
026-suspend-identity-api.ts — POST /v1/identities/:id/suspend
027-reactivate-identity-api.ts — POST /v1/identities/:id/reactivate
028-retire-identity-api.ts — POST /v1/identities/:id/retire
029-delete-identity-api.ts — DELETE /v1/identities/:id
030-identity-lifecycle-e2e.ts — E2E: full lifecycle

TDD for each. Write ALL 10 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-4', {
    agent: 'domain-4-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 031-040 (Domain 4: Scopes & RBAC).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate:
031-scope-parser.ts through 040-rbac-e2e.ts

TDD for each. Write ALL 10 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-5', {
    agent: 'domain-5-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 041-050 (Domain 5: API Routes).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate:
041-auth-middleware.ts through 050-api-routes-e2e.ts

TDD for each. Write ALL 10 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-6', {
    agent: 'domain-6-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 051-058 (Domain 6: Audit & Observability).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate:
051-audit-logger.ts through 058-audit-e2e.ts

TDD for each. Write ALL 8 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-7', {
    agent: 'domain-7-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 059-068 (Domain 7: SDK & Verification).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate:
059-sdk-client-identities.ts through 068-sdk-e2e.ts

TDD for each. The Go middleware (066) and Python SDK (067) are special —
they write Go/Python code, not TypeScript. Use appropriate verification.

Write ALL 10 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-8', {
    agent: 'domain-8-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 069-075 (Domain 8: CLI).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate:
069-cli-framework.ts through 075-cli-e2e.ts

TDD for each. Write ALL 7 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-9', {
    agent: 'domain-9-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 076-082 (Domain 9: Integration).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

These are cross-repo workflows — they touch relaycast, relayfile, and cloud.
Each workflow needs to read code from the target repo and make changes there.

Generate:
076-relaycast-integration.ts — relaycast verifies relayauth tokens
077-relayfile-integration.ts — relayfile verifies relayauth tokens
078-cloud-integration.ts — cloud launcher mints relayauth tokens
079-cross-plane-scope-check.ts — verify each plane enforces scopes
080-identity-propagation.ts — agent created in relaycast → auto-created in relayauth
081-revocation-propagation.ts — revoke in relayauth → loses access everywhere
082-integration-e2e.ts — one token across all planes

Write ALL 7 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-10', {
    agent: 'domain-10-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 083-090 (Domain 10: Hosted Server / relayauth-cloud).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

These workflows build the private relayauth-cloud repo (CF Workers deployment).
Reference relaycast's wrangler.toml and deploy patterns.

Generate:
083-wrangler-config.ts through 090-hosted-e2e.ts

Write ALL 8 files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('gen-domain-11-12', {
    agent: 'domain-11-12-gen',
    dependsOn: ['create-template'],
    task: `Generate workflows 091-100 (Domains 11-12: Testing/CI/Docs/Landing).

Read the generation rules: cat ${ROOT}/docs/workflow-generation-rules.md
Read the manifest: cat ${ROOT}/specs/workflow-manifest.md

Generate:
091-unit-test-suite.ts — Complete unit tests
092-integration-test-suite.ts — Integration tests
093-e2e-test-script.ts — scripts/e2e.ts (comprehensive, like relaycast)
094-ci-workflow.ts — GitHub Actions CI
095-publish-npm-workflow.ts — npm publish with provenance
096-deploy-workflow.ts — wrangler deploy on push
097-readme.ts — Comprehensive README
098-api-docs.ts — API reference from OpenAPI
099-integration-guides.ts — Integration guides for each plane
100-landing-page.ts — relayauth.dev landing page

Write ALL 10 files to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 4: Verify all generated ──────────────────────────────────

  .step('verify-all-files', {
    type: 'deterministic',
    dependsOn: [
      'gen-domain-1', 'gen-domain-2', 'gen-domain-3', 'gen-domain-4',
      'gen-domain-5', 'gen-domain-6', 'gen-domain-7', 'gen-domain-8',
      'gen-domain-9', 'gen-domain-10', 'gen-domain-11-12',
    ],
    command: `cd ${ROOT}/workflows && \
total=$(ls *.ts 2>/dev/null | wc -l | tr -d ' ') && \
echo "Total workflow files: $total" && \
echo "" && \
echo "=== Missing ===" && \
for i in $(seq -w 1 100); do \
  pattern="${i}-*.ts"; \
  count=$(ls $pattern 2>/dev/null | wc -l | tr -d ' '); \
  if [ "$count" -eq "0" ] && [ "$i" != "000" ]; then \
    echo "MISSING: $i"; \
  fi; \
done && \
echo "" && \
echo "=== Syntax check (top-level await) ===" && \
for f in *.ts; do \
  if grep -q "^const result = await" "$f" 2>/dev/null; then \
    echo "TOP-LEVEL AWAIT: $f"; \
  fi; \
done && \
echo "" && \
echo "=== Agent pattern check ===" && \
for f in *.ts; do \
  if ! grep -q "cli: 'claude'" "$f" 2>/dev/null; then \
    echo "NO CLAUDE LEAD: $f"; \
  fi; \
  if ! grep -q "cli: 'codex'" "$f" 2>/dev/null && ! grep -q "spec\\.ts$\\|000" <<< "$f"; then \
    echo "NO CODEX WORKER: $f"; \
  fi; \
done`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-and-fix', {
    agent: 'workflow-architect',
    dependsOn: ['verify-all-files'],
    task: `Review the generated workflows and fix issues.

Verification results:
{{steps.verify-all-files.output}}

1. Fix any missing workflows
2. Fix any top-level await issues (must use async function main pattern)
3. Fix any workflows missing claude leads or codex workers
4. Spot-check 3 random workflows from different domains for quality:
   - Do they follow the TDD pattern? (tests before implementation)
   - Do they use deterministic steps for file reads?
   - Do they have verification gates?
   - Are task prompts under 20 lines?
   - Is maxConcurrency 4-5?

Fix any issues found. Run the syntax check again after fixing.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n000 Generate All Workflows: ${result.status}`);
}

main().catch(console.error);
