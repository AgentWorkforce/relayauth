/**
 * 067-python-sdk.ts
 *
 * Domain 7: SDK & Verification
 * Python SDK: verify + client (for Python agent frameworks)
 *
 * Depends on: 063
 * Run: agent-relay run workflows/067-python-sdk.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('067-python-sdk')
  .description('Python SDK: verify + client (for Python agent frameworks)')
  .pattern('dag')
  .channel('wf-relayauth-067')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design Python SDK package, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write Python tests for relayauth SDK',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement Python relayauth SDK with verify and client',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review Python SDK for security, Pythonic patterns, and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-identity-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('read-verify-ts', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-client-ts', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/typescript/src/client.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-token-types', 'read-identity-types', 'read-scope-types', 'read-verify-ts', 'read-client-ts'],
    task: `Write Python tests for the relayauth Python SDK.

TypeScript types to port:
{{steps.read-token-types.output}}

Identity types:
{{steps.read-identity-types.output}}

Scope types:
{{steps.read-scope-types.output}}

TypeScript verify (reference):
{{steps.read-verify-ts.output}}

TypeScript client (reference):
{{steps.read-client-ts.output}}

First create ${ROOT}/packages/sdk/python/pyproject.toml:
[project]
name = "relayauth"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["httpx>=0.25", "PyJWT>=2.8", "cryptography>=41"]

[project.optional-dependencies]
dev = ["pytest>=7", "pytest-asyncio>=0.21", "respx>=0.20"]

Write Python tests to ${ROOT}/packages/sdk/python/tests/test_relayauth.py using pytest:

1. test_verify_valid_token — verify a valid RS256 JWT
2. test_verify_expired_token — reject expired token (raises TokenExpiredError)
3. test_verify_invalid_signature — reject tampered token
4. test_verify_wrong_audience — reject wrong audience
5. test_jwks_caching — JWKS fetched once, cached for subsequent calls
6. test_scope_matching — wildcard scope matching
7. test_client_create_identity — POST /v1/identities
8. test_client_get_identity — GET /v1/identities/:id
9. test_client_issue_token — POST /v1/tokens
10. test_client_revoke_token — POST /v1/tokens/revoke

Use respx to mock httpx requests. Use cryptography to generate test RSA keys.
Also create ${ROOT}/packages/sdk/python/tests/__init__.py (empty).`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/sdk/python/tests/test_relayauth.py && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-types', 'read-identity-types', 'read-scope-types', 'read-verify-ts', 'read-client-ts'],
    task: `Implement the Python relayauth SDK.

TypeScript types:
{{steps.read-token-types.output}}

Identity types:
{{steps.read-identity-types.output}}

TypeScript verify (reference):
{{steps.read-verify-ts.output}}

TypeScript client (reference):
{{steps.read-client-ts.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/sdk/python/relayauth/__init__.py:
from .verifier import TokenVerifier, VerifyOptions
from .client import RelayAuthClient
from .errors import RelayAuthError, TokenExpiredError, TokenRevokedError, InsufficientScopeError
from .types import Claims, TokenPair, AgentIdentity

Create ${ROOT}/packages/sdk/python/relayauth/types.py:
- Claims dataclass (matching TS RelayAuthTokenClaims)
- TokenPair dataclass
- AgentIdentity dataclass

Create ${ROOT}/packages/sdk/python/relayauth/errors.py:
- RelayAuthError(Exception) with code and status_code
- TokenExpiredError, TokenRevokedError, InsufficientScopeError

Create ${ROOT}/packages/sdk/python/relayauth/verifier.py:
- TokenVerifier class with verify(token) -> Claims
- JWKS fetching with httpx, caching with TTL
- Uses PyJWT for JWT decode + cryptography for key handling

Create ${ROOT}/packages/sdk/python/relayauth/client.py:
- RelayAuthClient class with httpx.AsyncClient
- create_identity, get_identity, issue_token, revoke_token, query_audit
- Async methods using httpx

Create ${ROOT}/packages/sdk/python/relayauth/scopes.py:
- match_scope(required, granted) -> bool with wildcard matching`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/sdk/python/relayauth/__init__.py && echo "init OK" || echo "init MISSING"; test -f ${ROOT}/packages/sdk/python/relayauth/verifier.py && echo "verifier OK" || echo "verifier MISSING"; test -f ${ROOT}/packages/sdk/python/relayauth/client.py && echo "client OK" || echo "client MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT}/packages/sdk/python && pip install -e ".[dev]" 2>&1 | tail -5 && python -m pytest tests/ -v 2>&1 | tail -40; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('type-check', {
    type: 'deterministic',
    dependsOn: ['run-tests'],
    command: `cd ${ROOT}/packages/sdk/python && python -m py_compile relayauth/verifier.py && python -m py_compile relayauth/client.py && python -m py_compile relayauth/types.py && echo "compile OK"; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['run-tests', 'type-check'],
    task: `Review the Python relayauth SDK.

Test results:
{{steps.run-tests.output}}

Type check results:
{{steps.type-check.output}}

Read the Python SDK files in ${ROOT}/packages/sdk/python/relayauth/. Check:
1. Token verification uses PyJWT correctly with RS256
2. JWKS fetching uses httpx with proper caching
3. Claims dataclass matches TypeScript types
4. Client uses httpx.AsyncClient with proper error handling
5. Scope matching with wildcards is correct
6. Error types map to TypeScript equivalents
7. Pythonic patterns: dataclasses, type hints, async/await
8. No security issues: algorithm pinning, proper key validation
List issues to fix (or confirm all good).`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix issues from the review.

Reviewer feedback:
{{steps.review.output}}

Test results:
{{steps.run-tests.output}}

Type check results:
{{steps.type-check.output}}

Fix all issues. Then run:
cd ${ROOT}/packages/sdk/python && python -m pytest tests/ -v`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n067 Python SDK: ${result.status}`);
}

main().catch(console.error);
