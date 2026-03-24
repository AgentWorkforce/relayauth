/**
 * 001-project-scaffold.ts
 *
 * Domain 1: Foundation
 * Scaffolds the relayauth monorepo structure with TypeScript,
 * test infrastructure, and shared configuration.
 *
 * Run: agent-relay run workflows/001-project-scaffold.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';

async function main() {
const result = await workflow('001-project-scaffold')
  .description('Scaffold relayauth monorepo: packages, tsconfig, test infra')
  .pattern('dag')
  .channel('wf-relayauth-001')
  .maxConcurrency(3)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design monorepo structure, shared config, test patterns',
    cwd: ROOT,
  })
  .agent('scaffolder', {
    cli: 'codex',
    preset: 'worker',
    role: 'Create all scaffold files',
    cwd: ROOT,
  })
  .agent('test-infra', {
    cli: 'codex',
    preset: 'worker',
    role: 'Set up test infrastructure and helpers',
    cwd: ROOT,
  })

  // ── Read reference patterns ────────────────────────────────────────

  .step('read-relaycast-structure', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/package.json && echo "=== TSCONFIG ===" && cat ${RELAYCAST}/tsconfig.base.json && echo "=== TURBO ===" && cat ${RELAYCAST}/turbo.json`,
    captureOutput: true,
  })

  .step('read-relaycast-server-pkg', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/package.json`,
    captureOutput: true,
  })

  .step('read-relaycast-sdk-pkg', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/sdk-typescript/package.json`,
    captureOutput: true,
  })

  .step('read-relaycast-test-helpers', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  // ── Design ─────────────────────────────────────────────────────────

  .step('design-scaffold', {
    agent: 'architect',
    dependsOn: [
      'read-relaycast-structure', 'read-relaycast-server-pkg',
      'read-relaycast-sdk-pkg', 'read-relaycast-test-helpers', 'read-spec',
    ],
    task: `Design the relayauth monorepo structure.

Architecture spec:
{{steps.read-spec.output}}

Reference — relaycast monorepo:
Root package.json: {{steps.read-relaycast-structure.output}}
Server package: {{steps.read-relaycast-server-pkg.output}}
SDK package: {{steps.read-relaycast-sdk-pkg.output}}

Design and write a plan to ${ROOT}/docs/scaffold-plan.md:

Monorepo structure:
relayauth/
├── package.json              # workspace root (npm workspaces)
├── turbo.json                # turborepo config
├── tsconfig.base.json        # shared TS config
├── packages/
│   ├── types/                # @relayauth/types — shared types, token format, scope format
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── token.ts      # JWT claims interface
│   │   │   ├── scope.ts      # scope format, parser, matcher
│   │   │   ├── identity.ts   # agent identity types
│   │   │   ├── rbac.ts       # role, policy types
│   │   │   └── audit.ts      # audit log entry types
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── sdk/                  # @relayauth/sdk — TS SDK for verification + management
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts     # RelayAuthClient
│   │   │   ├── verify.ts     # token verification (zero-dep)
│   │   │   ├── scopes.ts     # scope checking utilities
│   │   │   └── errors.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── server/               # internal — CF Workers server (will move to relayauth-cloud)
│   │   ├── src/
│   │   │   ├── worker.ts
│   │   │   ├── env.ts
│   │   │   ├── routes/
│   │   │   ├── engine/
│   │   │   ├── durable-objects/
│   │   │   ├── middleware/
│   │   │   ├── db/
│   │   │   │   └── migrations/
│   │   │   ├── lib/
│   │   │   └── __tests__/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cli/                  # relayauth CLI
│       ├── src/
│       │   ├── index.ts
│       │   └── commands/
│       ├── package.json
│       └── tsconfig.json
├── specs/
├── docs/
├── scripts/
│   ├── e2e.ts
│   └── generate-dev-token.sh
└── wrangler.toml

Be specific about every package.json (name, deps, scripts).`,
    verification: { type: 'exit_code' },
  })

  // ── Scaffold (parallel) ────────────────────────────────────────────

  .step('create-root-config', {
    agent: 'scaffolder',
    dependsOn: ['design-scaffold'],
    task: `Create the root monorepo configuration files.

Plan:
{{steps.design-scaffold.output}}

Create these files at ${ROOT}/:

1. package.json — workspace root with npm workspaces:
   {
     "name": "relayauth",
     "private": true,
     "workspaces": ["packages/*"],
     "scripts": {
       "build": "turbo build",
       "test": "turbo test",
       "typecheck": "turbo typecheck",
       "dev": "turbo dev",
       "e2e": "npx tsx scripts/e2e.ts"
     },
     "devDependencies": {
       "turbo": "^2",
       "typescript": "^5.7",
       "wrangler": "^4"
     }
   }

   IMPORTANT: This REPLACES the existing package.json. The old one just had
   @agent-relay/sdk. Keep that dependency but restructure as a workspace root.

2. turbo.json — build pipeline (match relaycast pattern)

3. tsconfig.base.json — shared compiler options:
   target: ES2022, module: ESNext, moduleResolution: bundler,
   strict: true, declaration: true, sourceMap: true

4. .gitignore — node_modules, dist, .wrangler, .env, *.log, .turbo

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('create-types-package', {
    agent: 'scaffolder',
    dependsOn: ['design-scaffold'],
    task: `Create the @relayauth/types package.

Plan:
{{steps.design-scaffold.output}}

Create ${ROOT}/packages/types/:

1. package.json:
   name: "@relayauth/types", version: "0.1.0"
   main: "dist/index.js", types: "dist/index.d.ts", type: "module"
   scripts: { build: "tsc", typecheck: "tsc --noEmit" }
   publishConfig: { access: "public", provenance: true }

2. tsconfig.json — extends ../../tsconfig.base.json, outDir: dist, rootDir: src

3. src/index.ts — barrel export for all types

4. src/token.ts:
   export interface RelayAuthTokenClaims {
     sub: string;          // agent identity: "agent_xxxx"
     org: string;          // organization: "org_xxxx"
     wks: string;          // workspace: "ws_xxxx"
     scopes: string[];     // capability scopes
     iss: string;          // "https://relayauth.dev"
     aud: string[];        // ["relaycast", "relayfile", "cloud"]
     exp: number;          // expiry (unix epoch)
     iat: number;          // issued at
     jti: string;          // unique token ID: "tok_xxxx"
     sid?: string;         // session ID (for refresh tokens)
     meta?: Record<string, string>; // custom metadata
   }

   export interface TokenPair {
     accessToken: string;
     refreshToken: string;
     accessTokenExpiresAt: string;
     refreshTokenExpiresAt: string;
     tokenType: "Bearer";
   }

   export interface JWKSResponse {
     keys: JsonWebKey[];
   }

5. src/scope.ts:
   // Scope format: {plane}:{resource}:{action}:{path?}
   // Examples:
   //   relaycast:channel:read:*
   //   relayfile:fs:write:/src/api/*
   //   cloud:workflow:run
   //   relayauth:identity:manage

   export type Plane = "relaycast" | "relayfile" | "cloud" | "relayauth";
   export type Action = "read" | "write" | "create" | "delete" | "manage" | "run" | "send" | "invoke" | "*";

   export interface ParsedScope {
     plane: Plane;
     resource: string;
     action: Action;
     path: string; // "*" for wildcard
     raw: string;
   }

   export interface ScopeTemplate {
     name: string;
     description: string;
     scopes: string[];
   }

   // Built-in scope templates
   export const SCOPE_TEMPLATES = {
     "relaycast:full": {
       name: "Relaycast Full Access",
       description: "Full read/write access to all relaycast resources",
       scopes: ["relaycast:*:*:*"],
     },
     "relayfile:read-only": {
       name: "Relayfile Read Only",
       description: "Read-only access to relayfile",
       scopes: ["relayfile:fs:read:*"],
     },
     // ... more templates
   } as const;

6. src/identity.ts:
   export type IdentityStatus = "active" | "suspended" | "retired";
   export type IdentityType = "agent" | "human" | "service";

   export interface AgentIdentity {
     id: string;           // "agent_xxxx"
     name: string;         // display name
     type: IdentityType;
     orgId: string;
     status: IdentityStatus;
     scopes: string[];     // directly assigned scopes
     roles: string[];      // role names
     metadata: Record<string, string>;
     createdAt: string;
     updatedAt: string;
     lastActiveAt?: string;
     suspendedAt?: string;
     suspendReason?: string;
   }

   export interface CreateIdentityInput {
     name: string;
     type?: IdentityType;
     scopes?: string[];
     roles?: string[];
     metadata?: Record<string, string>;
     workspaceId?: string;
   }

7. src/rbac.ts:
   export interface Role {
     id: string;
     name: string;         // "backend-developer"
     description: string;
     scopes: string[];     // scopes this role grants
     orgId: string;
     workspaceId?: string; // null = org-level role
     builtIn: boolean;
     createdAt: string;
   }

   export type PolicyEffect = "allow" | "deny";
   export type PolicyConditionType = "time" | "ip" | "identity" | "workspace";

   export interface PolicyCondition {
     type: PolicyConditionType;
     operator: "eq" | "neq" | "in" | "not_in" | "gt" | "lt" | "matches";
     value: string | string[];
   }

   export interface Policy {
     id: string;
     name: string;
     effect: PolicyEffect;
     scopes: string[];     // scopes this policy applies to
     conditions: PolicyCondition[];
     priority: number;     // higher = evaluated first
     orgId: string;
     workspaceId?: string;
     createdAt: string;
   }

8. src/audit.ts:
   export type AuditAction =
     | "token.issued" | "token.refreshed" | "token.revoked" | "token.validated"
     | "identity.created" | "identity.updated" | "identity.suspended" | "identity.retired"
     | "scope.checked" | "scope.denied"
     | "role.assigned" | "role.removed"
     | "policy.created" | "policy.updated" | "policy.deleted"
     | "key.rotated";

   export interface AuditEntry {
     id: string;
     action: AuditAction;
     identityId: string;
     orgId: string;
     workspaceId?: string;
     plane?: string;       // which plane the action was on
     resource?: string;    // the resource being accessed
     result: "allowed" | "denied" | "error";
     metadata?: Record<string, string>;
     ip?: string;
     userAgent?: string;
     timestamp: string;
   }

   export interface AuditQuery {
     identityId?: string;
     action?: AuditAction;
     orgId?: string;
     workspaceId?: string;
     plane?: string;
     result?: "allowed" | "denied";
     from?: string;        // ISO timestamp
     to?: string;
     cursor?: string;
     limit?: number;
   }

Write ALL files to disk. Make sure every type is exported from index.ts.`,
    verification: { type: 'exit_code' },
  })

  .step('create-sdk-package', {
    agent: 'scaffolder',
    dependsOn: ['design-scaffold'],
    task: `Create the @relayauth/sdk package scaffold.

Plan:
{{steps.design-scaffold.output}}

Create ${ROOT}/packages/sdk/:

1. package.json:
   name: "@relayauth/sdk", version: "0.1.0"
   dependencies: { "@relayauth/types": "workspace:*" }
   main, types, type, scripts, publishConfig (same pattern as types)

2. tsconfig.json — extends base, references types package

3. src/index.ts — barrel export (empty for now, populated by later workflows)

4. src/client.ts — scaffold only:
   import type { TokenPair, AgentIdentity, CreateIdentityInput, AuditQuery, AuditEntry } from "@relayauth/types";

   export interface RelayAuthClientOptions {
     baseUrl: string;
     apiKey?: string;
     token?: string;
   }

   export class RelayAuthClient {
     constructor(options: RelayAuthClientOptions) {}
     // Methods added by subsequent workflows
   }

5. src/verify.ts — scaffold only:
   export interface VerifyOptions {
     jwksUrl?: string;
     issuer?: string;
     audience?: string[];
     maxAge?: number;
   }

   export class TokenVerifier {
     constructor(options?: VerifyOptions) {}
     // Methods added by workflow 013
   }

6. src/scopes.ts — scaffold only:
   export class ScopeChecker {
     // Methods added by workflow 033
   }

7. src/errors.ts:
   export class RelayAuthError extends Error {
     constructor(message: string, public code: string, public statusCode?: number) {
       super(message);
       this.name = "RelayAuthError";
     }
   }

   export class TokenExpiredError extends RelayAuthError {
     constructor() { super("Token has expired", "token_expired", 401); }
   }

   export class TokenRevokedError extends RelayAuthError {
     constructor() { super("Token has been revoked", "token_revoked", 401); }
   }

   export class InsufficientScopeError extends RelayAuthError {
     constructor(required: string, actual: string[]) {
       super(\`Insufficient scope: requires \${required}, has [\${actual.join(", ")}]\`, "insufficient_scope", 403);
     }
   }

   export class IdentityNotFoundError extends RelayAuthError {
     constructor(id: string) { super(\`Identity not found: \${id}\`, "identity_not_found", 404); }
   }

   export class IdentitySuspendedError extends RelayAuthError {
     constructor(id: string) { super(\`Identity suspended: \${id}\`, "identity_suspended", 403); }
   }

Write ALL files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('create-server-scaffold', {
    agent: 'scaffolder',
    dependsOn: ['design-scaffold'],
    task: `Create the server package scaffold.

Plan:
{{steps.design-scaffold.output}}

Create ${ROOT}/packages/server/:

1. package.json:
   name: "relayauth-server" (private: true, not published)
   dependencies: { hono: "^4", "@relayauth/types": "workspace:*" }
   devDependencies: { "@cloudflare/workers-types": "^4", wrangler: "^4" }
   scripts: { dev: "wrangler dev", build: "tsc", typecheck: "tsc --noEmit", test: "node --test --import tsx src/__tests__/*.test.ts" }

2. tsconfig.json — extends base, types: ["@cloudflare/workers-types"]

3. src/env.ts:
   export type AppEnv = {
     Bindings: {
       IDENTITY_DO: DurableObjectNamespace;
       DB: D1Database;
       REVOCATION_KV: KVNamespace;
       SIGNING_KEY: string;        // RS256 or EdDSA private key
       SIGNING_KEY_ID: string;     // key ID for JWKS
       INTERNAL_SECRET: string;    // for admin operations
     };
     Variables: {
       requestId: string;
     };
   };

4. src/worker.ts:
   import { Hono } from "hono";
   import type { AppEnv } from "./env.js";
   // Placeholder — routes added by later workflows
   const app = new Hono<AppEnv>();
   app.get("/health", (c) => c.json({ status: "ok" }));
   export default app;
   // DO exports added by later workflows

5. src/__tests__/test-helpers.ts:
   // Test helper scaffold — reference relaycast's pattern
   // Will be populated by workflow 010

6. Create empty directories:
   src/routes/
   src/engine/
   src/durable-objects/
   src/middleware/
   src/db/migrations/
   src/lib/

Write ALL files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('create-cli-scaffold', {
    agent: 'scaffolder',
    dependsOn: ['design-scaffold'],
    task: `Create the CLI package scaffold.

Create ${ROOT}/packages/cli/:

1. package.json:
   name: "relayauth-cli", bin: { relayauth: "./dist/index.js" }
   dependencies: { "@relayauth/sdk": "workspace:*", "@relayauth/types": "workspace:*" }
   scripts: { build: "tsc", dev: "tsx src/index.ts" }

2. tsconfig.json

3. src/index.ts:
   #!/usr/bin/env node
   console.log("relayauth CLI — coming soon");
   // Commands added by workflows 069-075

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('setup-test-infra', {
    agent: 'test-infra',
    dependsOn: ['create-server-scaffold', 'read-relaycast-test-helpers'],
    task: `Set up the test infrastructure.

Relaycast test helpers:
{{steps.read-relaycast-test-helpers.output}}

Create:

1. ${ROOT}/packages/server/src/__tests__/test-helpers.ts:
   - createTestApp() — returns a Hono app with mocked bindings
   - mockD1() — in-memory D1 mock (or use miniflare)
   - mockKV() — in-memory KV mock
   - mockDO() — Durable Object stub mock
   - generateTestToken(claims) — creates a signed JWT for testing
   - generateTestIdentity(overrides) — creates an AgentIdentity
   - assertJsonResponse(response, status, bodyCheck) — assertion helper
   - createTestRequest(method, path, body?, headers?) — Request builder

2. ${ROOT}/packages/types/src/__tests__/scope.test.ts:
   - Placeholder test: "scope types are exported correctly"
   - Uses node:test

3. ${ROOT}/packages/sdk/src/__tests__/verify.test.ts:
   - Placeholder test: "TokenVerifier can be instantiated"

4. ${ROOT}/scripts/generate-dev-token.sh:
   Same pattern as relayfile's token script but for relayauth:
   Sign { sub: "agent_test", org: "org_test", wks: "ws_test", scopes: ["*"], exp: now+3600 }
   with HS256 secret "dev-secret"

Write ALL files to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Verify ─────────────────────────────────────────────────────────

  .step('install-and-verify', {
    type: 'deterministic',
    dependsOn: ['create-root-config', 'create-types-package', 'create-sdk-package', 'create-server-scaffold', 'create-cli-scaffold', 'setup-test-infra'],
    command: `cd ${ROOT} && npm install 2>&1 | tail -5 && echo "=== Structure ===" && find packages -name "*.ts" -not -path "*/node_modules/*" | sort && echo "" && echo "=== Build ===" && npx turbo build 2>&1 | tail -10; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'architect',
    dependsOn: ['install-and-verify'],
    task: `Fix any build errors.

Build output:
{{steps.install-and-verify.output}}

If EXIT: 0, verify the structure looks right and summarize what was created.
If errors, fix them. Then run: cd ${ROOT} && npx turbo build && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n001 Project Scaffold: ${result.status}`);
}

main().catch(console.error);
