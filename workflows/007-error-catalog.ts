/**
 * 007-error-catalog.ts
 *
 * Domain 1: Foundation
 * Define all error codes, messages, HTTP status mappings
 *
 * Depends on: 001
 * Run: agent-relay run workflows/007-error-catalog.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('007-error-catalog')
  .description('Define all error codes, messages, HTTP status mappings')
  .pattern('dag')
  .channel('wf-relayauth-007')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design error catalog, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the error catalog spec and implementation',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review error catalog for completeness and consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-sdk-errors', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/errors.ts`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/index.ts`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-sdk-errors', 'read-types'],
    task: `Design the error catalog.

Architecture:
{{steps.read-architecture.output}}

Existing SDK errors:
{{steps.read-sdk-errors.output}}

Write design outline to ${ROOT}/docs/error-catalog-design.md covering:
- Error response format: { error: { code, message, details? } }
- Error categories: auth, token, identity, scope, rbac, audit, rate_limit, validation, internal
- HTTP status mappings for each category
- Error codes: snake_case, prefixed by category
- Align with existing SDK error classes`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full error catalog.

Design:
{{steps.design-spec.output}}

Existing SDK errors:
{{steps.read-sdk-errors.output}}

Write to ${ROOT}/specs/error-catalog.md. Include a table for every error:
| Code | Message | HTTP Status | When |

Categories to cover:
- Auth: invalid_token, token_expired, token_revoked, missing_auth
- Identity: identity_not_found, identity_suspended, identity_retired
- Scope: insufficient_scope, invalid_scope_format
- RBAC: role_not_found, policy_denied, policy_conflict
- Validation: invalid_request, missing_field, invalid_field
- Rate limit: rate_limit_exceeded
- Internal: internal_error, service_unavailable

Also write the error response JSON format with examples.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/error-catalog.md && wc -l ${ROOT}/specs/error-catalog.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the error catalog.

Read ${ROOT}/specs/error-catalog.md and check:
1. Every API endpoint's possible errors are covered
2. HTTP status codes follow REST conventions
3. Error codes are unique and consistently named
4. Error messages are helpful but don't leak internals
5. Aligns with SDK error classes in errors.ts
6. Response format is consistent across all errors
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the error catalog.

Reviewer feedback:
{{steps.review-spec.output}}

Address all feedback. Update ${ROOT}/specs/error-catalog.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n007 Error Catalog: ${result.status}`);
}

main().catch(console.error);
