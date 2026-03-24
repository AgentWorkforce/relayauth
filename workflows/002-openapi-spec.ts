/**
 * 002-openapi-spec.ts
 *
 * Domain 1: Foundation
 * Write the OpenAPI v3 spec for all relayauth endpoints
 *
 * Depends on: 001
 * Run: agent-relay run workflows/002-openapi-spec.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('002-openapi-spec')
  .description('Write the OpenAPI v3 spec for all relayauth endpoints')
  .pattern('dag')
  .channel('wf-relayauth-002')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design OpenAPI spec structure, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the OpenAPI v3 YAML spec document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review OpenAPI spec for completeness and consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts && echo "=== IDENTITY ===" && cat ${ROOT}/packages/types/src/identity.ts && echo "=== SCOPE ===" && cat ${ROOT}/packages/types/src/scope.ts && echo "=== RBAC ===" && cat ${ROOT}/packages/types/src/rbac.ts && echo "=== AUDIT ===" && cat ${ROOT}/packages/types/src/audit.ts`,
    captureOutput: true,
  })

  .step('read-manifest', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/workflow-manifest.md`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-types', 'read-manifest'],
    task: `Design the OpenAPI v3 spec for relayauth.

Architecture:
{{steps.read-architecture.output}}

Types:
{{steps.read-types.output}}

Design outline to ${ROOT}/docs/openapi-design.md covering:
- All endpoint groups: tokens, identities, roles, policies, audit, admin, health
- Auth scheme (Bearer JWT)
- Common response schemas (error, pagination)
- All request/response bodies derived from the types`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full OpenAPI v3 spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

Types:
{{steps.read-types.output}}

Write to ${ROOT}/specs/openapi.yaml. Include:
- openapi: 3.1.0, info, servers (localhost + production)
- securitySchemes: BearerAuth (JWT)
- All paths: /health, /v1/tokens/**, /v1/identities/**, /v1/roles/**, /v1/policies/**, /v1/audit/**, /v1/admin/**, /v1/api-keys/**, /.well-known/jwks.json
- Reusable schemas in components for all types
- Proper error responses (400, 401, 403, 404, 409, 429, 500)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/openapi.yaml && wc -l ${ROOT}/specs/openapi.yaml`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the OpenAPI spec.

Read ${ROOT}/specs/openapi.yaml and check:
1. All endpoints from architecture are present
2. Request/response schemas match types package
3. Proper auth on all protected routes
4. Pagination on list endpoints
5. Error responses are consistent
6. No missing edge cases (suspend, retire, revoke flows)
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the OpenAPI spec.

Reviewer feedback:
{{steps.review-spec.output}}

Read each issue from the reviewer feedback above. For each one:
1. Open the file mentioned
2. Make the specific fix described
3. Save the file

After all fixes, verify by reading the file again to confirm changes were applied.

Update ${ROOT}/specs/openapi.yaml.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n002 OpenAPI Spec: ${result.status}`);
}

main().catch(console.error);
