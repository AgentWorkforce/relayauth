/**
 * 101-well-known-spec.ts
 *
 * Domain 13: Discovery & Ecosystem
 * Define /.well-known/agent-configuration response schema and discovery protocol
 *
 * Depends on: 002, 012
 * Run: agent-relay run workflows/101-well-known-spec.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('101-well-known-spec')
  .description('Define /.well-known/agent-configuration response schema and discovery protocol')
  .pattern('dag')
  .channel('wf-relayauth-101')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design agent-configuration discovery spec, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the discovery spec document and TypeScript types',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review spec for completeness, consistency with existing JWKS endpoint',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-openapi', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/openapi.yaml 2>/dev/null || cat ${ROOT}/specs/openapi.md 2>/dev/null || echo "NO OPENAPI SPEC FOUND"`,
    captureOutput: true,
  })

  .step('read-jwks-endpoint', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/routes/well-known.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts 2>/dev/null || echo "FILE NOT FOUND"`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-openapi', 'read-jwks-endpoint', 'read-scope-types'],
    task: `Design the /.well-known/agent-configuration discovery spec.

Architecture:
{{steps.read-architecture.output}}

Existing JWKS endpoint:
{{steps.read-jwks-endpoint.output}}

Scope types:
{{steps.read-scope-types.output}}

Design a spec for GET /.well-known/agent-configuration that:
1. Describes relayauth server capabilities (auth modes, endpoints, algorithms)
2. Lists supported scope patterns and their schemas
3. Points to JWKS endpoint, token endpoint, identity endpoint
4. Includes server metadata (version, issuer, supported_grant_types)
5. Is compatible with Agent Auth Protocol's discovery format where sensible
6. Extends it with relayauth-specific fields (sponsor_required, budgets, scope_delegation)

Write the design outline to ${ROOT}/docs/101-well-known-design.md.
Include: JSON schema, field descriptions, example response.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full well-known agent-configuration spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

Write two files:

1. ${ROOT}/specs/well-known-agent-configuration.md — the full spec:
   - JSON response schema with all fields
   - Required vs optional fields
   - Example responses (minimal and full)
   - Versioning strategy
   - Cache-Control recommendations
   - Relationship to JWKS endpoint

2. ${ROOT}/packages/types/src/discovery.ts — TypeScript types:
   - AgentConfiguration interface
   - DiscoveryEndpoint, ScopeDefinition, GrantType types
   - Export from the types package index`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/well-known-agent-configuration.md && echo "spec OK" || echo "spec MISSING"; test -f ${ROOT}/packages/types/src/discovery.ts && echo "types OK" || echo "types MISSING"`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the well-known agent-configuration spec.

Read ${ROOT}/specs/well-known-agent-configuration.md and ${ROOT}/packages/types/src/discovery.ts.

Check:
1. Completeness — all endpoints from architecture are discoverable
2. Compatibility — works with both Agent Auth Protocol clients and A2A agents
3. Consistency — aligns with existing JWKS endpoint pattern
4. Security — no sensitive info leaked in public discovery
5. TypeScript types match the JSON schema exactly
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the well-known spec.

Reviewer feedback:
{{steps.review-spec.output}}

Address all feedback. Update both:
- ${ROOT}/specs/well-known-agent-configuration.md
- ${ROOT}/packages/types/src/discovery.ts

Then run: cd ${ROOT} && npx turbo typecheck 2>&1 | tail -20`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n101 Well-Known Spec: ${result.status}`);
}

main().catch(console.error);
