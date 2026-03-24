/**
 * 098-api-docs.ts
 *
 * Domain 12: Docs & Landing
 * Full API reference generated from OpenAPI spec
 *
 * Depends on: 002
 * Run: agent-relay run workflows/098-api-docs.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('098-api-docs')
  .description('Full API reference generated from OpenAPI spec')
  .pattern('dag')
  .channel('wf-relayauth-098')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design API docs structure, finalize after review',
    cwd: ROOT,
  })
  .agent('doc-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write API reference documentation from OpenAPI spec',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review API docs for accuracy and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-openapi', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/openapi.yaml 2>/dev/null || cat ${ROOT}/specs/openapi.md 2>/dev/null || echo "No OpenAPI spec"`,
    captureOutput: true,
  })

  .step('read-error-catalog', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/error-catalog.md 2>/dev/null || echo "No error catalog"`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/index.ts && echo "=== token ===" && cat ${ROOT}/packages/types/src/token.ts && echo "=== identity ===" && cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('design-docs', {
    agent: 'architect',
    dependsOn: ['read-openapi', 'read-error-catalog', 'read-types'],
    task: `Design the API reference documentation structure.

OpenAPI spec:
{{steps.read-openapi.output}}

Error catalog:
{{steps.read-error-catalog.output}}

Write outline to ${ROOT}/docs/098-api-docs-outline.md:
1. Authentication (API keys, bearer tokens)
2. Tokens: POST /v1/tokens, refresh, revoke, introspect
3. Identities: CRUD, suspend, reactivate, retire
4. Roles: CRUD, assign/remove
5. Policies: CRUD
6. Audit: query, export, webhooks
7. Admin: stats, key rotation
8. Error reference
Each endpoint: method, path, params, request body, response, example.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-api-docs', {
    agent: 'doc-writer',
    dependsOn: ['design-docs'],
    task: `Write the full API reference documentation.

Outline:
{{steps.design-docs.output}}

OpenAPI spec:
{{steps.read-openapi.output}}

Types:
{{steps.read-types.output}}

Write to ${ROOT}/docs/api-reference.md.
For each endpoint include: method, path, auth, params, request/response with JSON examples.
Include curl examples. Keep consistent formatting.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-docs', {
    type: 'deterministic',
    dependsOn: ['write-api-docs'],
    command: `test -f ${ROOT}/docs/api-reference.md && wc -l ${ROOT}/docs/api-reference.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['verify-docs'],
    task: `Review the API reference documentation.

Read ${ROOT}/docs/api-reference.md. Check:
1. All endpoints from OpenAPI spec are documented
2. Request/response examples are valid JSON
3. Auth requirements documented per endpoint
4. Error codes referenced correctly
5. Consistent formatting throughout
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Finalize the API docs.

Reviewer feedback:
{{steps.review.output}}

Address all feedback. Update ${ROOT}/docs/api-reference.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n098 API Docs: ${result.status}`);
}

main().catch(console.error);
