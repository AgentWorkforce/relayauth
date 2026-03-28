# relayauth Scaffold Plan

## Monorepo Structure

```
relayauth/
├── package.json              # workspace root (npm workspaces + turborepo)
├── turbo.json                # turborepo task config
├── tsconfig.base.json        # shared TS compiler options
├── vitest.workspace.ts       # vitest workspace config
├── .gitignore
├── .npmrc
├── packages/
│   ├── types/                # @relayauth/types
│   ├── sdk/                  # @relayauth/sdk
│   ├── server/               # @relayauth/server (internal, moves to relayauth-cloud later)
│   └── cli/                  # relayauth (CLI binary)
├── specs/                    # OpenAPI, token format, scope format, RBAC, audit specs
├── docs/                     # documentation, guides
├── scripts/
│   ├── e2e.ts                # E2E test runner
│   └── generate-dev-token.sh # local dev token generator
└── wrangler.toml             # CF Workers config (points to packages/server)
```

---

## Root Configuration

### package.json

```json
{
  "name": "relayauth",
  "private": true,
  "description": "Agent identity and authorization for the Agent Relay ecosystem",
  "packageManager": "npm@10.9.4",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "test:watch": "turbo test:watch",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "dev": "wrangler dev --config wrangler.toml",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply relayauth --local",
    "db:migrate:remote": "wrangler d1 migrations apply relayauth --remote",
    "e2e": "npx tsx scripts/e2e.ts",
    "generate-dev-token": "bash scripts/generate-dev-token.sh"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.9",
    "turbo": "^2.4.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18",
    "wrangler": "^4.66.0"
  }
}
```

### turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "test:watch": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

### tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "composite": true
  }
}
```

### vitest.workspace.ts

```ts
export default [
  "packages/types",
  "packages/sdk",
  "packages/server",
  "packages/cli",
];
```

### .npmrc

```
save-exact=true
```

---

## Package: @relayauth/types

Shared types for the entire relayauth ecosystem. Zero runtime dependencies.

### packages/types/package.json

```json
{
  "name": "@relayauth/types",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  },
  "files": ["dist"],
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relayauth",
    "directory": "packages/types"
  }
}
```

### packages/types/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### Source files

```
packages/types/src/
├── index.ts          # Re-exports all types
├── token.ts          # JWT claims: RelayAuthToken, TokenClaims, RefreshToken
├── scope.ts          # Scope string format, ScopeDescriptor, wildcard types
├── identity.ts       # AgentIdentity, IdentityStatus, SponsorChain, BehavioralBudget
├── rbac.ts           # Role, Policy, PolicyEffect, PolicyCondition
├── audit.ts          # AuditEntry, AuditAction, AuditFilter, AuditExportFormat
├── organization.ts   # Organization, Workspace, WorkspaceMembership
└── errors.ts         # ErrorCode enum, ErrorResponse type
```

**Key types to define:**

- `token.ts`: `RelayAuthTokenClaims` (sub, org, wks, sponsor, sponsorChain, scopes, budget, parentTokenId, iss, aud, exp, iat, jti), `TokenPair` (accessToken + refreshToken), `SigningAlgorithm` (RS256 | EdDSA)
- `scope.ts`: `Scope` (string brand type), `ScopeDescriptor` ({ plane, resource, action, path? }), `ScopePattern` for wildcard matching
- `identity.ts`: `AgentIdentity` ({ id, name, org, workspace, sponsor, sponsorChain, scopes, roles, budget, status, metadata, createdAt, updatedAt }), `IdentityStatus` (active | suspended | retired | deleted), `BehavioralBudget` ({ maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend })
- `rbac.ts`: `Role` ({ id, name, scopes, workspace }), `Policy` ({ id, effect, subjects, resources, actions, conditions }), `PolicyEffect` (allow | deny)
- `audit.ts`: `AuditEntry` ({ id, timestamp, action, identity, org, workspace, sponsorChain, resource, scope, result, metadata }), `AuditAction` enum
- `errors.ts`: `RelayAuthErrorCode` enum, `RelayAuthErrorResponse` ({ code, message, status, details? })

---

## Package: @relayauth/sdk

TypeScript SDK for token verification and identity management. The verification module is zero-dependency (can run at the edge).

### packages/sdk/typescript/package.json

```json
{
  "name": "@relayauth/sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./verify": {
      "types": "./dist/verify.d.ts",
      "import": "./dist/verify.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@relayauth/types": "0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  },
  "files": ["dist"],
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relayauth",
    "directory": "packages/sdk"
  }
}
```

### packages/sdk/typescript/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../types" }
  ]
}
```

### Source files

```
packages/sdk/typescript/src/
├── index.ts          # Public API: RelayAuthClient, verify, ScopeChecker
├── client.ts         # RelayAuthClient — HTTP client for all /v1 endpoints
├── verify.ts         # Zero-dep JWT verification (Web Crypto API)
├── scopes.ts         # ScopeChecker: parse, match, intersect, validate scopes
├── errors.ts         # SDK-specific error classes (RelayAuthError, TokenExpiredError, etc.)
└── types.ts          # SDK-specific config types (ClientOptions, VerifyOptions)
```

**Key classes:**

- `RelayAuthClient` — initialized with `{ baseUrl, apiKey }`, methods: `createAgent()`, `getAgent()`, `listAgents()`, `updateAgent()`, `suspendAgent()`, `revokeAgent()`, `issueToken()`, `refreshToken()`, `revokeToken()`, `createRole()`, `assignRole()`, `queryAudit()`
- `verify(token, jwksUrl)` — zero-dep JWT verification using Web Crypto, fetches JWKS, caches keys, validates signature + claims + expiry + revocation
- `ScopeChecker` — `parse(scope)`, `matches(granted, requested)`, `intersect(parentScopes, childScopes)`, `validate(scope)`

---

## Package: @relayauth/server

Cloudflare Workers server using Hono. This package is internal and will eventually move to a private `relayauth-cloud` repo.

### packages/server/package.json

```json
{
  "name": "@relayauth/server",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/worker.js",
  "types": "dist/worker.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev"
  },
  "dependencies": {
    "@relayauth/types": "0.1.0",
    "@relayauth/sdk": "0.1.0",
    "drizzle-orm": "^0.45.1",
    "hono": "^4.11.9",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260217.0",
    "drizzle-kit": "^0.31.9",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18",
    "wrangler": "^4.66.0"
  },
  "files": ["dist"]
}
```

### packages/server/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src"],
  "references": [
    { "path": "../types" },
    { "path": "../sdk" }
  ]
}
```

### Source files

```
packages/server/src/
├── worker.ts                 # Hono app entry point, exports default worker
├── env.ts                    # Env bindings type (KV, D1, DO, secrets)
│
├── routes/
│   ├── tokens.ts             # POST /v1/tokens, /v1/tokens/refresh, /v1/tokens/revoke, /v1/tokens/introspect
│   ├── identities.ts         # CRUD /v1/identities, suspend, reactivate, retire, delete
│   ├── roles.ts              # CRUD /v1/roles, /v1/identities/:id/roles
│   ├── policies.ts           # CRUD /v1/policies
│   ├── organizations.ts      # CRUD /v1/organizations
│   ├── workspaces.ts         # CRUD /v1/workspaces, /v1/workspaces/:id/members
│   ├── audit.ts              # GET /v1/audit, POST /v1/audit/export, /v1/audit/webhooks
│   ├── admin.ts              # /v1/admin/* system routes
│   ├── well-known.ts         # GET /.well-known/jwks.json
│   └── health.ts             # GET /health
│
├── engine/
│   ├── token-issuer.ts       # JWT signing (RS256/EdDSA), token pair generation
│   ├── token-verifier.ts     # Server-side token verification
│   ├── revocation.ts         # KV-based revocation list, propagation
│   ├── key-manager.ts        # Signing key rotation, JWKS generation
│   ├── scope-evaluator.ts    # Scope matching + policy evaluation combined
│   └── budget-enforcer.ts    # Behavioral budget check + decrement
│
├── durable-objects/
│   └── identity-do.ts        # IdentityDO: per-agent state, session tracking, budget counters
│
├── middleware/
│   ├── auth.ts               # Extract token, validate, attach identity to Hono context
│   ├── scope-guard.ts        # Per-route scope checking middleware
│   ├── rate-limit.ts         # Per-identity and per-org rate limiting
│   ├── error-handler.ts      # Global error handler, consistent error format
│   └── cors.ts               # CORS config, security headers, request ID
│
├── db/
│   ├── schema.ts             # Drizzle schema: identities, roles, policies, audit_logs, orgs, workspaces
│   └── migrations/           # D1 migration files
│
├── lib/
│   ├── id.ts                 # ID generation (agent_xxxx, org_xxxx, ws_xxxx, tok_xxxx)
│   ├── time.ts               # TTL parsing, expiry calculation
│   └── crypto.ts             # Key generation, signing helpers
│
└── __tests__/
    ├── helpers/
    │   ├── factory.ts         # Test factories: createTestAgent, createTestToken, etc.
    │   ├── mock-env.ts        # Mock CF bindings (KV, D1, DO)
    │   └── assertions.ts      # Custom test assertions
    ├── engine/
    │   ├── token-issuer.test.ts
    │   ├── revocation.test.ts
    │   ├── scope-evaluator.test.ts
    │   └── budget-enforcer.test.ts
    ├── routes/
    │   ├── tokens.test.ts
    │   ├── identities.test.ts
    │   └── ...
    └── middleware/
        ├── auth.test.ts
        └── scope-guard.test.ts
```

---

## Package: relayauth (CLI)

CLI tool for managing agents, tokens, and audit logs.

### packages/cli/package.json

```json
{
  "name": "relayauth",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "relayauth": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@relayauth/sdk": "0.1.0",
    "@relayauth/types": "0.1.0",
    "commander": "^13.1.0"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  },
  "files": ["dist"]
}
```

### packages/cli/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../types" },
    { "path": "../sdk" }
  ]
}
```

### Source files

```
packages/cli/src/
├── index.ts          # #!/usr/bin/env node entry, commander setup
└── commands/
    ├── agent.ts      # relayauth agent create|get|list|suspend|revoke|delete
    ├── token.ts      # relayauth token issue|refresh|revoke|introspect
    ├── role.ts       # relayauth role create|list|assign|remove
    ├── audit.ts      # relayauth audit query|export
    └── config.ts     # relayauth config set|get (base URL, API key)
```

---

## wrangler.toml

```toml
name = "relayauth"
main = "packages/server/dist/worker.js"
compatibility_date = "2024-12-01"

[vars]
ENVIRONMENT = "development"

[[kv_namespaces]]
binding = "REVOCATION_KV"
id = "TBD"

[[d1_databases]]
binding = "DB"
database_name = "relayauth"
database_id = "TBD"

[durable_objects]
bindings = [
  { name = "IDENTITY_DO", class_name = "IdentityDO" }
]

[[migrations]]
tag = "v1"
new_classes = ["IdentityDO"]
```

---

## D1 Schema (initial)

```sql
-- identities
CREATE TABLE identities (
  id TEXT PRIMARY KEY,          -- agent_xxxx
  name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sponsor TEXT NOT NULL,         -- user who created this agent
  sponsor_chain TEXT NOT NULL,   -- JSON array of sponsor chain
  scopes TEXT NOT NULL,          -- JSON array of scope strings
  roles TEXT NOT NULL DEFAULT '[]', -- JSON array of role IDs
  budget TEXT,                   -- JSON: { maxActionsPerHour, maxCostPerDay, alertThreshold, autoSuspend }
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended | retired | deleted
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- roles
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  scopes TEXT NOT NULL,          -- JSON array of scope strings
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(name, org_id, workspace_id)
);

-- policies
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  effect TEXT NOT NULL,           -- allow | deny
  subjects TEXT NOT NULL,         -- JSON: identity IDs, role names, or wildcards
  resources TEXT NOT NULL,        -- JSON: scope patterns
  actions TEXT NOT NULL,          -- JSON: action names
  conditions TEXT DEFAULT '{}',   -- JSON: time, IP, etc.
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- audit_logs
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  identity_id TEXT,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  sponsor_chain TEXT,
  resource TEXT,
  scope TEXT,
  result TEXT NOT NULL,            -- success | denied | error
  metadata TEXT DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT
);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_identity ON audit_logs(identity_id);
CREATE INDEX idx_audit_org ON audit_logs(org_id);

-- organizations
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,            -- org_xxxx
  name TEXT NOT NULL,
  settings TEXT DEFAULT '{}',     -- JSON: max token TTL, default budget, etc.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- workspaces
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,            -- ws_xxxx
  name TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  settings TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- workspace_members
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, identity_id)
);

-- signing_keys
CREATE TABLE signing_keys (
  kid TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,        -- RS256 | EdDSA
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,      -- encrypted
  status TEXT NOT NULL DEFAULT 'active', -- active | rotated | revoked
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
```

---

## Build & Dependency Order

```
@relayauth/types  (no deps)
       ↓
@relayauth/sdk    (depends on types)
       ↓
@relayauth/server (depends on types + sdk)
       ↓
relayauth (CLI)   (depends on types + sdk)
```

Turborepo handles this automatically via `"dependsOn": ["^build"]`.

---

## Implementation Order (aligned with workflow domains)

### Phase 1: Foundation (workflows 001-010)
1. Create monorepo structure, all package.json files, tsconfig, turbo.json
2. Implement `@relayauth/types` — all type definitions
3. Set up vitest workspace with test helpers and factories
4. Set up wrangler.toml, D1 schema, initial migration
5. Create OpenAPI spec stub at `specs/openapi.yaml`

### Phase 2: Token System (workflows 011-020)
1. `server/engine/token-issuer.ts` — RS256/EdDSA JWT signing
2. `server/routes/well-known.ts` — JWKS endpoint
3. `sdk/verify.ts` — zero-dep JWT verification
4. `server/routes/tokens.ts` — issue, refresh, revoke, introspect
5. `server/engine/revocation.ts` — KV-based revocation
6. `server/engine/key-manager.ts` — key rotation

### Phase 3: Identity Lifecycle (workflows 021-030)
1. `server/durable-objects/identity-do.ts` — per-agent state
2. `server/routes/identities.ts` — full CRUD + suspend/reactivate/retire
3. Sponsor chain validation and propagation

### Phase 4: Scopes & RBAC (workflows 031-040)
1. `sdk/scopes.ts` — scope parser, matcher, intersector
2. `server/middleware/scope-guard.ts` — per-route scope checking
3. `server/routes/roles.ts` + `server/routes/policies.ts`
4. `server/engine/scope-evaluator.ts` — policy evaluation engine
5. `server/engine/budget-enforcer.ts` — behavioral budgets

### Phase 5: API Routes (workflows 041-050)
1. `server/middleware/auth.ts` — request authentication
2. `server/routes/organizations.ts` + `server/routes/workspaces.ts`
3. `server/middleware/rate-limit.ts`
4. `server/middleware/error-handler.ts` + `server/middleware/cors.ts`

### Phase 6: Audit & Observability (workflows 051-058)
1. `server/routes/audit.ts` — audit logger, query, export
2. Webhook delivery for budget alerts and audit events
3. Dashboard stats API

### Phase 7: SDK & CLI (workflows 059-075)
1. `sdk/client.ts` — full RelayAuthClient implementation
2. `cli/` — all commands wired to SDK

### Phase 8: Integration & Deployment (workflows 076-090)
1. relaycast integration (token validation middleware)
2. CF Workers deployment pipeline
3. KV, D1, DO production setup

### Phase 9: Testing & CI (workflows 091-096)
1. E2E test suite in `scripts/e2e.ts`
2. Contract tests (OpenAPI spec vs implementation)
3. CI/CD pipeline (GitHub Actions)
4. npm publish with provenance

### Phase 10: Docs & Landing (workflows 097-100)
1. Documentation site
2. Getting started guide
3. Landing page

---

## Test Strategy

- **Unit tests**: Vitest, co-located in `__tests__/` dirs. TDD — write tests first.
- **Integration tests**: Test route handlers with mock CF bindings. No external calls.
- **E2E tests**: `scripts/e2e.ts` — runs against `wrangler dev`, tests full flows.
- **Contract tests**: Validate routes match OpenAPI spec.

### Test helpers (in server package)

- `factory.ts`: `createTestAgent()`, `createTestToken()`, `createTestOrg()`, `createTestPolicy()`
- `mock-env.ts`: In-memory KV, D1, and DO mocks for unit tests
- `assertions.ts`: `expectScopeMatch()`, `expectAuditEntry()`, `expectTokenValid()`

---

## Conventions

- **IDs**: Prefixed — `agent_`, `org_`, `ws_`, `tok_`, `role_`, `pol_`, `aud_` + nanoid
- **Timestamps**: ISO 8601 strings in D1, Unix seconds in JWT
- **Errors**: Consistent `{ code, message, status, details? }` format
- **Scopes**: `{plane}:{resource}:{action}:{path?}` — always validated at parse time
- **Token TTL**: Default 1h access, 24h refresh. Max 30d. Always enforced.
