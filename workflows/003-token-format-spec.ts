/**
 * 003-token-format-spec.ts
 *
 * Domain 1: Foundation
 * Define JWT claims, signing algorithms, JWKS format
    - sponsorId (string, required): human user ID accountable for this agent
    - sponsorChain (string[]): delegation chain tracing back to human
    - parentTokenId (string, optional): for sub-agent delegation — scopes must be subset of parent
    - budget ({ maxActionsPerHour, maxCostPerDay, remaining }): behavioral rate limits
    - MANDATORY EXPIRY: every token must have exp. Default: 1h access, 24h refresh. Max: 30 days. No permanent tokens.

 *
 * Depends on: 001
 * Run: agent-relay run workflows/003-token-format-spec.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('003-token-format-spec')
  .description('Define JWT claims, signing algorithms, JWKS format')
    - sponsorId (string, required): human user ID accountable for this agent
    - sponsorChain (string[]): delegation chain tracing back to human
    - parentTokenId (string, optional): for sub-agent delegation — scopes must be subset of parent
    - budget ({ maxActionsPerHour, maxCostPerDay, remaining }): behavioral rate limits
    - MANDATORY EXPIRY: every token must have exp. Default: 1h access, 24h refresh. Max: 30 days. No permanent tokens.

  .pattern('dag')
  .channel('wf-relayauth-003')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design token format spec, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the token format spec document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review token spec for security and completeness',
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
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-types'],
    task: `Design the token format specification.

Architecture:
{{steps.read-architecture.output}}

Token types:
{{steps.read-types.output}}

Write design outline to ${ROOT}/docs/token-format-design.md covering:
- JWT header: alg (RS256 primary, EdDSA optional), typ, kid
- JWT claims: all fields from RelayAuthTokenClaims
    - sponsorId (string, required): human user ID accountable for this agent
    - sponsorChain (string[]): delegation chain tracing back to human
    - parentTokenId (string, optional): for sub-agent delegation — scopes must be subset of parent
    - budget ({ maxActionsPerHour, maxCostPerDay, remaining }): behavioral rate limits
    - MANDATORY EXPIRY: every token must have exp. Default: 1h access, 24h refresh. Max: 30 days. No permanent tokens.

- Signing algorithms: RS256 for compatibility, EdDSA for performance
- JWKS format: key structure, rotation semantics, kid convention
- Token lifetime: access (15min), refresh (7d)
- Token ID format: tok_xxxx (nanoid)`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full token format spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

Token types:
{{steps.read-types.output}}

Write to ${ROOT}/specs/token-format.md. Include:
- JWT structure (header, payload, signature)
- All claims with types, required/optional, validation rules
- Signing algorithm details (RS256, EdDSA)
- JWKS endpoint response format
- Key rotation: grace period, kid convention
- Token pair semantics (access + refresh)
- Example tokens (encoded + decoded)`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/token-format.md && wc -l ${ROOT}/specs/token-format.md`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the token format spec.

Read ${ROOT}/specs/token-format.md and check:
1. All claims from RelayAuthTokenClaims are documented
2. Signing algorithm choices are secure and justified
3. JWKS format follows RFC 7517
4. Key rotation strategy is safe (grace period)
5. Token lifetimes are reasonable
6. No security gaps (replay, confusion attacks)
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the token format spec.

Reviewer feedback:
{{steps.review-spec.output}}

Address all feedback. Update ${ROOT}/specs/token-format.md.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n003 Token Format Spec: ${result.status}`);
}

main().catch(console.error);
