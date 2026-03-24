# relayauth Workflow Manifest

100 workflows to build relayauth from scratch, TDD, with full E2E testing.

## Domain 1: Foundation (001-010)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 001 | project-scaffold | Monorepo: packages, tsconfig, turbo, test infra | architect, scaffolder, test-infra | — |
| 002 | openapi-spec | Write the OpenAPI v3 spec for all relayauth endpoints | architect, spec-writer | 001 |
| 003 | token-format-spec | Define JWT claims, signing algorithms, JWKS format | architect, spec-writer | 001 |
| 004 | scope-format-spec | Define scope syntax, wildcard matching, path patterns | architect, spec-writer | 001 |
| 005 | rbac-spec | Define role/policy format, inheritance, evaluation order | architect, spec-writer | 004 |
| 006 | audit-spec | Define audit log format, retention, query semantics | architect, spec-writer | 001 |
| 007 | error-catalog | Define all error codes, messages, HTTP status mappings | architect, implementer | 001 |
| 008 | test-helpers-complete | Full test helper suite: mocks, factories, assertions | architect, test-dev | 001 |
| 009 | dev-environment | Local dev: wrangler dev, seed data, dev tokens | architect, dev-ops | 001 |
| 010 | contract-tests | Tests that verify implementation matches OpenAPI spec | architect, test-dev | 002 |

## Domain 2: Token System (011-020)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 011 | jwt-signing | RS256/EdDSA JWT signing with key ID rotation support | architect, crypto-dev, test-dev | 003 |
| 012 | jwks-endpoint | GET /.well-known/jwks.json — public key publishing | architect, server-dev, test-dev | 011 |
| 013 | token-verification | Zero-dep JWT verification library (SDK) | architect, sdk-dev, test-dev | 011, 012 |
| 014 | token-issuance-api | POST /v1/tokens — issue access + refresh token pair | architect, server-dev, test-dev | 011 |
| 015 | token-refresh-api | POST /v1/tokens/refresh — refresh access token | architect, server-dev, test-dev | 014 |
| 016 | token-revocation-api | POST /v1/tokens/revoke — revoke token, propagate to KV | architect, server-dev, test-dev | 014 |
| 017 | revocation-kv | KV-based revocation list with global propagation | architect, server-dev, test-dev | 016 |
| 018 | token-introspect-api | GET /v1/tokens/introspect — token info without validation | architect, server-dev, test-dev | 014 |
| 019 | key-rotation | Automated signing key rotation with grace period | architect, server-dev, test-dev | 011, 012 |
| 020 | token-system-e2e | E2E: issue → validate → refresh → revoke → verify revoked | architect, test-dev | 011-019 |

## Domain 3: Identity Lifecycle (021-030)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 021 | identity-do | IdentityDO durable object — per-agent state | architect, do-dev, test-dev | 001 |
| 022 | create-identity-api | POST /v1/identities — create agent identity | architect, server-dev, test-dev | 021 |
| 023 | get-identity-api | GET /v1/identities/:id — read identity | architect, server-dev, test-dev | 022 |
| 024 | list-identities-api | GET /v1/identities — list/search identities | architect, server-dev, test-dev | 022 |
| 025 | update-identity-api | PATCH /v1/identities/:id — update metadata, scopes | architect, server-dev, test-dev | 022 |
| 026 | suspend-identity-api | POST /v1/identities/:id/suspend — suspend with reason | architect, server-dev, test-dev | 022, 016 |
| 027 | reactivate-identity-api | POST /v1/identities/:id/reactivate — lift suspension | architect, server-dev, test-dev | 026 |
| 028 | retire-identity-api | POST /v1/identities/:id/retire — permanent deactivation | architect, server-dev, test-dev | 026 |
| 029 | delete-identity-api | DELETE /v1/identities/:id — hard delete (with confirmation) | architect, server-dev, test-dev | 022 |
| 030 | identity-lifecycle-e2e | E2E: create → update → suspend → reactivate → retire | architect, test-dev | 021-029 |

## Domain 4: Scopes & RBAC (031-040)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 031 | scope-parser | Parse scope strings, validate format, wildcard matching | architect, sdk-dev, test-dev | 004 |
| 032 | scope-matcher | Match requested scope against granted scopes (with wildcards/paths) | architect, sdk-dev, test-dev | 031 |
| 033 | scope-checker-sdk | ScopeChecker class in SDK — high-level scope validation | architect, sdk-dev, test-dev | 032 |
| 034 | scope-middleware | Server middleware: extract token, check scopes per-route | architect, server-dev, test-dev | 033, 013 |
| 035 | role-crud-api | /v1/roles — create, read, update, delete roles | architect, server-dev, test-dev | 005 |
| 036 | role-assignment-api | POST /v1/identities/:id/roles — assign/remove roles | architect, server-dev, test-dev | 035, 022 |
| 037 | policy-crud-api | /v1/policies — create, read, update, delete policies | architect, server-dev, test-dev | 005 |
| 038 | policy-evaluation | Evaluate policies: merge scopes + roles + policies → effective permissions | architect, server-dev, test-dev | 037, 036 |
| 039 | scope-inheritance | Org → workspace → agent scope inheritance chain | architect, server-dev, test-dev | 038 |
| 040 | rbac-e2e | E2E: create role → assign → verify access → policy deny → verify denied | architect, test-dev | 031-039 |

## Domain 5: API Routes (041-050)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 041 | auth-middleware | Request auth: extract token, validate, attach identity to context | architect, server-dev, test-dev | 013, 034 |
| 042 | org-crud-api | /v1/organizations — create, read, update organizations | architect, server-dev, test-dev | 041 |
| 043 | workspace-crud-api | /v1/workspaces — create, read, update, list workspaces | architect, server-dev, test-dev | 042 |
| 044 | workspace-membership-api | /v1/workspaces/:id/members — add/remove identities | architect, server-dev, test-dev | 043, 022 |
| 045 | api-key-management | /v1/api-keys — create, list, revoke API keys (for orgs) | architect, server-dev, test-dev | 042 |
| 046 | admin-routes | /v1/admin/* — system-level operations | architect, server-dev, test-dev | 041 |
| 047 | rate-limiting | Per-identity and per-org rate limiting | architect, server-dev, test-dev | 041 |
| 048 | error-handling | Global error handler, consistent error response format | architect, server-dev, test-dev | 007 |
| 049 | cors-and-headers | CORS config, security headers, request ID | architect, server-dev, test-dev | 041 |
| 050 | api-routes-e2e | E2E: full API flow with auth, RBAC, rate limiting | architect, test-dev | 041-049 |

## Domain 6: Audit & Observability (051-058)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 051 | audit-logger | Core audit logging: write entries to D1 on every auth event | architect, server-dev, test-dev | 006 |
| 052 | audit-query-api | GET /v1/audit — query audit logs with filters | architect, server-dev, test-dev | 051 |
| 053 | audit-export-api | POST /v1/audit/export — export logs as CSV/JSON | architect, server-dev, test-dev | 052 |
| 054 | audit-retention | Configurable retention: auto-delete old entries | architect, server-dev, test-dev | 051 |
| 055 | audit-webhooks | POST /v1/audit/webhooks — notify external systems on events | architect, server-dev, test-dev | 051 |
| 056 | identity-activity-api | GET /v1/identities/:id/activity — identity-scoped audit view | architect, server-dev, test-dev | 052, 022 |
| 057 | dashboard-stats-api | GET /v1/stats — aggregate stats (tokens issued, scopes checked, etc.) | architect, server-dev, test-dev | 051 |
| 058 | audit-e2e | E2E: perform actions → query audit → verify entries → test retention | architect, test-dev | 051-057 |

## Domain 7: SDK & Verification (059-068)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 059 | sdk-client-identities | RelayAuthClient identity CRUD methods | architect, sdk-dev, test-dev | 022-029 |
| 060 | sdk-client-tokens | RelayAuthClient token methods (issue, refresh, revoke) | architect, sdk-dev, test-dev | 014-016 |
| 061 | sdk-client-roles | RelayAuthClient role management methods | architect, sdk-dev, test-dev | 035-036 |
| 062 | sdk-client-audit | RelayAuthClient audit query methods | architect, sdk-dev, test-dev | 052 |
| 063 | sdk-verify-complete | TokenVerifier: full implementation with JWKS fetching, caching | architect, sdk-dev, test-dev | 013 |
| 064 | sdk-middleware-hono | Hono middleware: verifyToken() for protecting routes | architect, sdk-dev, test-dev | 063 |
| 065 | sdk-middleware-express | Express middleware: verifyToken() for Node.js servers | architect, sdk-dev, test-dev | 063 |
| 066 | go-middleware | Go middleware: verify relayauth tokens (for relayfile-mount) | architect, go-dev, test-dev | 013 |
| 067 | python-sdk | Python SDK: verify + client (for Python agent frameworks) | architect, python-dev, test-dev | 063 |
| 068 | sdk-e2e | E2E: SDK client → server → verify → scope check (all languages) | architect, test-dev | 059-067 |

## Domain 8: CLI (069-075)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 069 | cli-framework | CLI framework: arg parsing, config file, output formatting | architect, cli-dev, test-dev | 001 |
| 070 | cli-login | relayauth login — authenticate, store credentials | architect, cli-dev, test-dev | 069 |
| 071 | cli-identity-commands | relayauth agent create/list/get/suspend/retire | architect, cli-dev, test-dev | 069, 059 |
| 072 | cli-token-commands | relayauth token issue/revoke/introspect | architect, cli-dev, test-dev | 069, 060 |
| 073 | cli-role-commands | relayauth role create/list/assign/remove | architect, cli-dev, test-dev | 069, 061 |
| 074 | cli-audit-commands | relayauth audit query/export/tail | architect, cli-dev, test-dev | 069, 062 |
| 075 | cli-e2e | E2E: full CLI flow — login → create agent → assign role → check access | architect, test-dev | 069-074 |

## Domain 9: Integration (076-082)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 076 | relaycast-integration | relaycast verifies relayauth tokens instead of its own | architect, server-dev, test-dev | 063, 034 |
| 077 | relayfile-integration | relayfile verifies relayauth tokens for fs operations | architect, server-dev, test-dev | 063, 066 |
| 078 | cloud-integration | cloud launcher mints relayauth tokens for workflow runs | architect, server-dev, test-dev | 014, 059 |
| 079 | cross-plane-scope-check | Agent with relaycast:read + relayfile:write — verify each plane enforces | architect, test-dev | 076, 077 |
| 080 | identity-propagation | Agent created in relaycast → auto-created in relayauth | architect, server-dev, test-dev | 076 |
| 081 | revocation-propagation | Agent revoked in relayauth → loses access in relaycast + relayfile | architect, test-dev | 076, 077, 016 |
| 082 | integration-e2e | E2E: agent uses one token to message (relaycast), read files (relayfile), run workflow (cloud) | architect, test-dev | 076-081 |

## Domain 10: Hosted Server (083-090)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 083 | wrangler-config | Complete wrangler.toml: DO, KV, D1, environments | architect, infra-dev | 001 |
| 084 | d1-migrations | All D1 migrations: identities, roles, policies, audit, api_keys | architect, server-dev | 042-057 |
| 085 | identity-do-complete | IdentityDO: full implementation with SQLite storage | architect, do-dev, test-dev | 021 |
| 086 | kv-revocation-complete | KV revocation: write on revoke, check on validate, TTL cleanup | architect, server-dev, test-dev | 017 |
| 087 | key-management-complete | Signing key storage, rotation, JWKS serving from KV | architect, server-dev, test-dev | 019 |
| 088 | deploy-staging | Deploy to staging: wrangler deploy --env staging | architect, infra-dev, test-dev | 083-087 |
| 089 | deploy-production | Deploy to production with migration safety checks | architect, infra-dev | 088 |
| 090 | hosted-e2e | E2E against staging: full flow including KV propagation timing | architect, test-dev | 088 |

## Domain 11: Testing & CI (091-096)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 091 | unit-test-suite | Complete unit tests for all engine functions | architect, test-dev | 001-050 |
| 092 | integration-test-suite | Integration tests: server + D1 + KV + DO together | architect, test-dev | 083-087 |
| 093 | e2e-test-script | scripts/e2e.ts — comprehensive smoke test (like relaycast) | architect, test-dev | all |
| 094 | ci-workflow | GitHub Actions: test, typecheck, build on every PR | architect, ci-dev | 091-092 |
| 095 | publish-npm-workflow | GitHub Actions: npm publish with provenance for types + sdk | architect, ci-dev | 094 |
| 096 | deploy-workflow | GitHub Actions: wrangler deploy on push to main | architect, ci-dev | 094 |

## Domain 12: Docs & Landing (097-100)

| # | Name | Description | Agents | Depends On |
|---|------|-------------|--------|------------|
| 097 | readme | Comprehensive README: quick start, architecture, API overview | architect, docs-writer | all |
| 098 | api-docs | Full API reference generated from OpenAPI spec | architect, docs-writer | 002 |
| 099 | integration-guides | Guides: relaycast integration, relayfile integration, cloud integration | architect, docs-writer | 076-078 |
| 100 | landing-page | relayauth.dev — landing page (Astro + Tailwind) | architect, frontend-dev, illustrator | all |
