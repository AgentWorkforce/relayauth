/**
 * 066-go-middleware.ts
 *
 * Domain 7: SDK & Verification
 * Go middleware: verify relayauth tokens (for relayfile-mount)
 *
 * Depends on: 013
 * Run: agent-relay run workflows/066-go-middleware.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('066-go-middleware')
  .description('Go middleware: verify relayauth tokens (for relayfile-mount)')
  .pattern('dag')
  .channel('wf-relayauth-066')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design Go middleware package, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write Go tests for relayauth token verification middleware',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement Go middleware for relayauth token verification',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review Go middleware for security, idiomatic Go, and correctness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-token-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/token.ts`,
    captureOutput: true,
  })

  .step('read-scope-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/scope.ts`,
    captureOutput: true,
  })

  .step('read-verify-ts', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/verify.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-go', {
    type: 'deterministic',
    command: `ls ${RELAYFILE}/cmd/ 2>/dev/null && cat ${RELAYFILE}/go.mod 2>/dev/null || echo "relayfile Go structure not available"`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-token-types', 'read-scope-types', 'read-verify-ts'],
    task: `Write Go tests for relayauth token verification middleware.

TypeScript token types (to port to Go):
{{steps.read-token-types.output}}

Scope types:
{{steps.read-scope-types.output}}

TypeScript verify implementation (for reference):
{{steps.read-verify-ts.output}}

Create Go test file at ${ROOT}/packages/go-middleware/relayauth_test.go.

First create ${ROOT}/packages/go-middleware/go.mod:
module github.com/anthropics/relayauth-go
go 1.21

Write Go tests using testing package:
1. TestVerifyToken_Valid — verify a valid JWT (create test RSA key pair)
2. TestVerifyToken_Expired — reject expired token
3. TestVerifyToken_InvalidSignature — reject tampered token
4. TestVerifyToken_WrongAudience — reject token with wrong audience
5. TestVerifyToken_WrongIssuer — reject token with wrong issuer
6. TestFetchJWKS — mock HTTP server serving JWKS, verify key fetching
7. TestJWKSCaching — verify JWKS is cached after first fetch
8. TestMiddleware — http.Handler middleware extracts token, sets claims in context
9. TestRequireScope — middleware checks scope in claims
10. TestScopeMatching — wildcard scope matching (relaycast:*:*:* matches relaycast:channel:read:general)

Use net/http/httptest for mock JWKS server and middleware tests.
Use crypto/rsa for generating test keys.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/go-middleware/relayauth_test.go && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-token-types', 'read-scope-types', 'read-verify-ts'],
    task: `Implement Go middleware for relayauth token verification.

TypeScript types to port:
{{steps.read-token-types.output}}

Scope types:
{{steps.read-scope-types.output}}

TypeScript verify (for reference):
{{steps.read-verify-ts.output}}

Tests to pass:
{{steps.write-tests.output}}

Create ${ROOT}/packages/go-middleware/relayauth.go with:

package relayauth

// Claims represents the JWT claims in a relayauth token
type Claims struct {
    Sub    string   // agent identity: "agent_xxxx"
    Org    string   // organization: "org_xxxx"
    Wks    string   // workspace: "ws_xxxx"
    Scopes []string // capability scopes
    Iss    string   // issuer
    Aud    []string // audience
    Exp    int64    // expiry unix epoch
    Iat    int64    // issued at
    Jti    string   // token ID
}

// VerifyOptions configures the token verifier
type VerifyOptions struct {
    JWKSUrl    string
    Issuer     string
    Audience   []string
    CacheTTL   time.Duration // default 5 min
}

// Verifier verifies relayauth JWTs
type Verifier struct { ... }

func NewVerifier(opts VerifyOptions) *Verifier
func (v *Verifier) Verify(tokenString string) (*Claims, error)
func (v *Verifier) Middleware(next http.Handler) http.Handler
func RequireScope(scope string) func(http.Handler) http.Handler

Also create ${ROOT}/packages/go-middleware/scope.go with:
func MatchScope(required, granted string) bool — wildcard matching

Use only Go stdlib: crypto/rsa, crypto/x509, encoding/json, net/http, sync.
No external dependencies.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/go-middleware/relayauth.go && echo "relayauth.go OK" || echo "relayauth.go MISSING"; test -f ${ROOT}/packages/go-middleware/scope.go && echo "scope.go OK" || echo "scope.go MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT}/packages/go-middleware && go test -v ./... 2>&1 | tail -40; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('go-vet', {
    type: 'deterministic',
    dependsOn: ['run-tests'],
    command: `cd ${ROOT}/packages/go-middleware && go vet ./... 2>&1; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['run-tests', 'go-vet'],
    task: `Review the Go middleware implementation.

Test results:
{{steps.run-tests.output}}

Go vet results:
{{steps.go-vet.output}}

Read ${ROOT}/packages/go-middleware/relayauth.go, scope.go, and the test file. Check:
1. JWT verification uses crypto/rsa correctly (RS256)
2. JWKS fetching with HTTP client and caching with sync.RWMutex
3. Claims struct matches TypeScript RelayAuthTokenClaims
4. Middleware follows Go http.Handler convention
5. Context key usage for storing claims (custom type, not string)
6. Scope matching with wildcards is correct
7. Error types are idiomatic Go (sentinel errors or typed errors)
8. No external dependencies (stdlib only)
9. Thread safety for JWKS cache
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

Go vet results:
{{steps.go-vet.output}}

Fix all issues. Then run:
cd ${ROOT}/packages/go-middleware && go test -v ./... && go vet ./...`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n066 Go Middleware: ${result.status}`);
}

main().catch(console.error);
