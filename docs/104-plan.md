# `@relayauth/ai` — Framework Adapter Types Package

## Overview

`@relayauth/ai` provides shared types, a base adapter class, and tool definitions for integrating RelayAuth into AI frameworks (Vercel AI SDK, LangChain, Model Context Protocol, etc.). Each framework adapter package (e.g., `@relayauth/ai-vercel`) extends the base adapter to translate framework-specific conventions into RelayAuth operations.

---

## Package Structure

```
packages/ai/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # barrel export
│   ├── types.ts              # shared adapter types
│   ├── base-adapter.ts       # BaseRelayAuthAdapter class
│   ├── tools.ts              # tool definitions (discover, register, etc.)
│   └── __tests__/
│       └── types.test.ts     # compile-time type assertions
```

---

## 1. Package Configuration

### package.json

```json
{
  "name": "@relayauth/ai",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@relayauth/types": "*"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "vitest": "^4.0.18"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

### tsconfig.json

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

No changes needed to `turbo.json` — the existing `build`/`test`/`typecheck` task definitions with `^build` dependency already cover new packages discovered via the `packages/*` workspaces glob.

---

## 2. Shared Types (`src/types.ts`)

### AdapterConfig

Configuration for creating an adapter instance. Mirrors the options available on `RelayAuthClient` and `TokenVerifier` but keeps them framework-agnostic.

```ts
import type {
  RelayAuthTokenClaims,
  TokenBudget,
  IdentityType,
  ParsedScope,
} from "@relayauth/types";

/** Configuration to initialize any adapter. */
export interface AdapterConfig {
  /** RelayAuth server base URL (e.g., "https://auth.example.com"). */
  serverUrl: string;
  /** API key for server-to-server calls (identity creation, token issuance). */
  apiKey?: string;
  /** Pre-existing bearer token for agent-level calls. */
  token?: string;
  /** JWKS URL override; defaults to discovery's jwks_uri. */
  jwksUrl?: string;
  /** Expected issuer for token verification. */
  issuer?: string;
  /** Expected audiences for token verification. */
  audience?: string[];
  /** Default scopes to request when registering or issuing tokens. */
  defaultScopes?: string[];
  /** Error callback invoked before the adapter returns an error to the framework. */
  onError?: (error: AdapterError) => void;
}
```

### AdapterTool

Generic definition for a tool that an adapter exposes to the AI framework. Each tool has a typed parameter schema and result type.

```ts
/** A tool that an adapter exposes to the AI framework. */
export interface AdapterTool<
  TName extends string = string,
  TParams = unknown,
  TResult = unknown,
> {
  /** Unique tool name (e.g., "relayauth_discover_service"). */
  name: TName;
  /** Human-readable description for the LLM. */
  description: string;
  /** JSON Schema describing the parameters. */
  parameters: Record<string, unknown>;
  /** Required scopes to invoke this tool (empty = no auth required). */
  requiredScopes: string[];
  /** Execute the tool. */
  execute: (params: TParams, context: ToolExecutionContext) => Promise<ToolResult<TResult>>;
}
```

### ToolResult

Standardized result envelope returned by every tool execution.

```ts
/** Standardized result from tool execution. */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
```

### ToolExecutionContext

Auth context available during tool execution.

```ts
/** Auth context available during tool execution. */
export interface ToolExecutionContext {
  /** Verified token claims, if the caller is authenticated. */
  claims?: RelayAuthTokenClaims;
  /** Scope checker interface (avoids hard dependency on @relayauth/sdk). */
  scopeChecker?: ScopeCheckerLike;
  /** Convenience identity subset from claims. */
  identity?: {
    id: string;
    orgId: string;
    type: IdentityType;
  };
  /** Sponsor chain from claims. */
  sponsorChain?: string[];
  /** Budget from claims. */
  budget?: TokenBudget;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}
```

### ScopeCheckerLike

Interface matching `ScopeChecker`'s public API so adapter packages don't need a hard dependency on `@relayauth/sdk`.

```ts
/** Interface-only contract matching ScopeChecker from @relayauth/sdk. */
export interface ScopeCheckerLike {
  check(scope: string): boolean;
  require(scope: string): void;
  checkAll(scopes: string[]): boolean;
  checkAny(scopes: string[]): boolean;
}
```

### AdapterError

```ts
/** Adapter-level error with code and optional HTTP status. */
export interface AdapterError {
  code: string;
  message: string;
  statusCode?: number;
}
```

---

## 3. Base Adapter Class (`src/base-adapter.ts`)

The `BaseRelayAuthAdapter` is an abstract class that wraps `RelayAuthClient` (for API calls) and `TokenVerifier` (for JWT verification). It holds the adapter config and provides concrete implementations for the five standard tools. Framework-specific adapters extend this class and override how tools are registered with the framework.

```ts
import type { AgentConfiguration, RelayAuthTokenClaims } from "@relayauth/types";

export abstract class BaseRelayAuthAdapter {
  protected config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  /** Return all standard tools for registration with the framework. */
  abstract getTools(): AdapterTool[];

  /** Verify a bearer token and return claims. */
  async verifyClaims(token: string): Promise<RelayAuthTokenClaims> { /* delegates to TokenVerifier */ }

  /** Build a ToolExecutionContext from verified claims. */
  protected buildContext(claims: RelayAuthTokenClaims): ToolExecutionContext { /* ... */ }

  /** Fetch the discovery document from serverUrl. */
  protected async fetchDiscovery(): Promise<AgentConfiguration> { /* ... */ }
}
```

**Key decisions:**

- The base class does **not** depend on `@relayauth/sdk` at the type level — it imports only from `@relayauth/types`. Concrete adapter packages that need the full SDK (client, verifier) take it as a peer dependency.
- `getTools()` is abstract because each framework has a different tool registration API (Vercel AI SDK uses `tool()`, LangChain uses `DynamicTool`, MCP uses JSON-RPC tool schemas).
- The base class provides protected helpers (`verifyClaims`, `buildContext`, `fetchDiscovery`) that concrete adapters call from within their framework-specific tool wrappers.

---

## 4. Tool Definitions (`src/tools.ts`)

Five standard tools that every adapter exposes. Each is defined as a plain object conforming to `AdapterTool` so adapters can translate them into framework-specific formats.

### 4.1 `discover_service`

Find and return the RelayAuth server's capabilities by fetching `/.well-known/agent-configuration`.

| Field | Value |
|---|---|
| **Name** | `relayauth_discover_service` |
| **Scopes** | _(none — public endpoint)_ |
| **Params** | `{ url: string }` — base URL of the service |
| **Result** | `AgentConfiguration` from `@relayauth/types` |

**Behavior:**
1. `GET {url}/.well-known/agent-configuration`
2. Parse and validate the JSON response against the `AgentConfiguration` interface
3. Cache the result (1 hour, matching the server's `Cache-Control`)
4. Return the full configuration including endpoints, scope definitions, and capabilities

### 4.2 `register_agent`

Create a new agent identity on the RelayAuth server.

| Field | Value |
|---|---|
| **Name** | `relayauth_register_agent` |
| **Scopes** | `relayauth:identity:create:*` |
| **Params** | `{ orgId: string, name: string, type?: IdentityType, scopes?: string[], metadata?: Record<string, string> }` |
| **Result** | `{ identity: AgentIdentity, tokens: TokenPair }` |

**Behavior:**
1. Call `RelayAuthClient.createIdentity(orgId, input)`
2. Call `RelayAuthClient.issueToken(identity.id, { scopes })` to immediately provision tokens
3. Return both the identity and the token pair so the agent can start making authenticated calls

### 4.3 `request_scope`

Request additional scopes for the current agent by issuing a new token with expanded scopes (subject to scope delegation rules).

| Field | Value |
|---|---|
| **Name** | `relayauth_request_scope` |
| **Scopes** | `relayauth:token:create:*` |
| **Params** | `{ identityId: string, scopes: string[], audience?: string[] }` |
| **Result** | `TokenPair` |

**Behavior:**
1. Validate requested scopes against the server's `scope_definitions` (from cached discovery)
2. Call `RelayAuthClient.issueToken(identityId, { scopes, audience })`
3. Return the new token pair
4. If scope delegation denies the request, return a `ToolResult` with `success: false` and the scope delegation error

### 4.4 `execute_with_auth`

Make an authenticated HTTP request to a service, automatically attaching the agent's bearer token.

| Field | Value |
|---|---|
| **Name** | `relayauth_execute_with_auth` |
| **Scopes** | _(varies — checked against the token's granted scopes)_ |
| **Params** | `{ url: string, method: HttpMethod, headers?: Record<string, string>, body?: unknown, requiredScope?: string }` |
| **Result** | `{ status: number, headers: Record<string, string>, body: unknown }` |

**Behavior:**
1. If `requiredScope` is provided, verify the current token grants it via `ScopeCheckerLike.check()`
2. Attach `Authorization: Bearer {token}` header
3. Execute the HTTP request
4. Return the response status, headers, and parsed body
5. On 401/403, return a structured error with the specific RelayAuth error code (`token_expired`, `insufficient_scope`, etc.)

### 4.5 `check_scope`

Verify whether a specific scope (or set of scopes) is granted by the current token without making an API call.

| Field | Value |
|---|---|
| **Name** | `relayauth_check_scope` |
| **Scopes** | _(none — local check only)_ |
| **Params** | `{ scope?: string, scopes?: string[], mode?: "all" \| "any" }` |
| **Result** | `{ granted: boolean, matched: string[], denied: string[] }` |

**Behavior:**
1. Parse the current token's claims
2. Use `ScopeCheckerLike` to check:
   - Single scope: `check(scope)`
   - Multiple with `mode: "all"`: `checkAll(scopes)`
   - Multiple with `mode: "any"`: `checkAny(scopes)`
3. Return the result with matched and denied scope lists

---

## 5. Framework Adapter Extension Pattern

Each framework adapter lives in its own package (e.g., `@relayauth/ai-vercel`, `@relayauth/ai-langchain`) and extends `BaseRelayAuthAdapter`.

### Extension contract

```ts
// packages/ai-vercel/src/adapter.ts
import { BaseRelayAuthAdapter, type AdapterTool } from "@relayauth/ai";
import { tool } from "ai"; // Vercel AI SDK

export class VercelRelayAuthAdapter extends BaseRelayAuthAdapter {
  getTools() {
    return STANDARD_TOOLS.map((def) => this.wrapTool(def));
  }

  private wrapTool(def: AdapterTool): ReturnType<typeof tool> {
    return tool({
      description: def.description,
      parameters: z.object(/* derive from def.parameters */),
      execute: async (params) => {
        // 1. Extract token from Vercel AI context
        // 2. Verify claims via this.verifyClaims(token)
        // 3. Build context via this.buildContext(claims)
        // 4. Check required scopes
        // 5. Call def.execute(params, context)
        // 6. Return result in Vercel AI format
      },
    });
  }
}
```

### What each adapter is responsible for

| Responsibility | Base (`@relayauth/ai`) | Framework Adapter |
|---|---|---|
| Tool definitions (name, params, logic) | Provided | Inherited |
| Token verification | `verifyClaims()` helper | Calls helper |
| Scope checking | `ScopeCheckerLike` interface | Passes to tools |
| Framework tool registration | Abstract `getTools()` | Implements |
| Request context extraction | N/A | Extracts headers/token from framework context |
| Error formatting | `ToolResult` envelope | Maps to framework error format |
| Token/discovery caching | Base class cache | Inherited |

### Planned adapters (future packages)

1. **`@relayauth/ai-vercel`** — Vercel AI SDK (`ai` package). Uses `tool()` and `CoreTool` types.
2. **`@relayauth/ai-langchain`** — LangChain.js. Uses `DynamicStructuredTool`.
3. **`@relayauth/ai-mcp`** — Model Context Protocol. Exposes tools as MCP JSON-RPC tool definitions with `inputSchema`.

---

## 6. Dependency Graph

```
@relayauth/types          (pure types, no runtime deps)
       ↑
@relayauth/ai             (types + base adapter + tool defs)
       ↑
@relayauth/ai-vercel      (Vercel AI SDK adapter)
@relayauth/ai-langchain   (LangChain adapter)
@relayauth/ai-mcp         (MCP adapter)
       ↑
@relayauth/sdk            (peer dep for adapters that need client/verifier runtime)
```

- `@relayauth/ai` depends only on `@relayauth/types` — no SDK runtime dependency.
- Framework adapter packages take `@relayauth/sdk` as a **peer dependency** so consumers control the SDK version.
- Framework-specific packages (e.g., `ai`, `langchain`) are also peer dependencies.

---

## 7. Testing Strategy

### Type tests (`src/__tests__/types.test.ts`)

Compile-time assertions using `vitest` and `expectTypeOf`:

- `AdapterTool` is structurally compatible with expected shapes
- `ToolResult` correctly narrows `data` when `success: true`
- `ScopeCheckerLike` is assignable from `ScopeChecker` (ensures interface stays in sync)
- `ToolExecutionContext.claims` correctly types to `RelayAuthTokenClaims`

### Unit tests (future, in adapter packages)

- Each tool's `execute` function tested with mock `RelayAuthClient` / `TokenVerifier`
- Error paths: expired token, insufficient scope, network failure, invalid discovery response
- Scope checking: single scope, checkAll, checkAny, wildcard matching

---

## 8. Implementation Order

| Step | What | Depends On |
|---|---|---|
| 1 | Create `packages/ai/` scaffold (package.json, tsconfig.json) | — |
| 2 | Write `src/types.ts` with all shared types | Step 1 |
| 3 | Write `src/tools.ts` with five tool definitions | Step 2 |
| 4 | Write `src/base-adapter.ts` with abstract base class | Steps 2–3 |
| 5 | Write `src/index.ts` barrel export | Steps 2–4 |
| 6 | Write `src/__tests__/types.test.ts` type assertions | Steps 2–4 |
| 7 | Verify `turbo build && turbo test && turbo typecheck` passes | Steps 1–6 |
