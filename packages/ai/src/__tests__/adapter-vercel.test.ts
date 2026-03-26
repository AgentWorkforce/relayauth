import assert from "node:assert/strict";
import test from "node:test";

import type { AgentConfiguration } from "@relayauth/types";

import { RelayAuthAdapter } from "../adapter.js";
import { createRelayAuthTools } from "../adapters/vercel.js";
import type { AdapterConfig, ToolResult } from "../types.js";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

type CoreToolLike = {
  description: string;
  parameters: {
    parse: (input: unknown) => unknown;
    safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

const baseUrl = "https://relay.example.test";
const accessToken = "adapter_access_token";

const discoveryDocument: AgentConfiguration = {
  schema_version: "1.0",
  issuer: baseUrl,
  service_name: "RelayAuth Test",
  jwks_uri: `${baseUrl}/.well-known/jwks.json`,
  token_endpoint: `${baseUrl}/v1/tokens`,
  identity_endpoint: `${baseUrl}/v1/identities`,
  grant_types_supported: ["client_credentials", "refresh_token"],
  token_endpoint_auth_methods_supported: ["bearer_token", "client_secret_post"],
  token_signing_alg_values_supported: ["RS256"],
  scope_format: {
    pattern: "{plane}:{resource}:{action}:{path?}",
    separator: ":",
    path_optional: true,
    wildcard: "*",
    planes: ["relaycast"],
    actions: ["read", "write", "delete"],
  },
  scope_definitions: [],
  sponsor_required: false,
  scope_delegation: {
    enabled: true,
    mode: "intersection",
    escalation_policy: "hard_error",
    max_depth: 3,
  },
  budgets: {
    enabled: false,
    supported_limits: [],
    alert_webhook_supported: false,
    auto_suspend_supported: false,
  },
  token_lifetimes: {
    access_token_default: "1h",
    refresh_token_default: "30d",
    maximum: "30d",
    permanent_tokens_allowed: false,
  },
  endpoints: {
    identities: {
      url: `${baseUrl}/v1/identities`,
      methods: ["GET", "POST"],
      auth: "bearer_token",
      description: "Manage identities",
    },
  },
};

function createConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    serverUrl: baseUrl,
    apiKey: "test_api_key",
    token: accessToken,
    autoDiscover: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function mockFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return responder(input, init);
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }

  if (input instanceof URL) {
    return new URL(input.toString());
  }

  return new URL(input.url);
}

async function inspectCall(call: FetchCall): Promise<{
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}> {
  const url = toUrl(call.input);
  const method = call.init?.method ?? (call.input instanceof Request ? call.input.method : "GET");
  const headers = new Headers(call.input instanceof Request ? call.input.headers : undefined);

  if (call.init?.headers) {
    const overrideHeaders = new Headers(call.init.headers);
    for (const [name, value] of overrideHeaders.entries()) {
      headers.set(name, value);
    }
  }

  let body = "";
  if (call.init?.body != null) {
    body = await new Response(call.init.body).text();
  } else if (call.input instanceof Request) {
    body = await call.input.clone().text();
  }

  return { url, method, headers, body };
}

function assertCoreToolRecord(value: unknown): asserts value is Record<string, CoreToolLike> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);

  for (const [name, tool] of Object.entries(value as Record<string, unknown>)) {
    assert.notEqual(name.length, 0);
    assert.equal(typeof tool, "object");
    assert.notEqual(tool, null);
  }
}

function expectCoreToolRecord<T extends Record<string, CoreToolLike>>(value: T): T {
  return value;
}

function assertToolShape(tool: CoreToolLike): void {
  assert.equal(typeof tool.description, "string");
  assert.notEqual(tool.description.length, 0);
  assert.equal(typeof tool.parameters, "object");
  assert.notEqual(tool.parameters, null);
  assert.equal(typeof tool.parameters.parse, "function");
  assert.equal(typeof tool.parameters.safeParse, "function");
  assert.equal(typeof tool.execute, "function");
}

test("createRelayAuthTools returns a CoreTool-compatible record", () => {
  const tools = expectCoreToolRecord(createRelayAuthTools(createConfig()));

  assertCoreToolRecord(tools);
  assert.ok(Object.keys(tools).length >= 4);

  for (const name of [
    "discover_service",
    "register_agent",
    "request_scope",
    "execute_with_auth",
    "check_scope",
  ]) {
    assert.ok(name in tools, `expected ${name} to be exposed`);
  }
});

test("each RelayAuth tool exposes description, zod parameters, and execute", () => {
  const tools = createRelayAuthTools(createConfig());

  assertCoreToolRecord(tools);

  for (const tool of Object.values(tools)) {
    assertToolShape(tool);
  }
});

test("discover_service delegates to adapter.discover() and returns its ToolResult", async (t) => {
  const originalDiscover = RelayAuthAdapter.prototype.discover;
  const calls: Array<{ self: RelayAuthAdapter; url?: string }> = [];

  RelayAuthAdapter.prototype.discover = (async function discoverSpy(this: RelayAuthAdapter, url?) {
    calls.push({ self: this, url });
    return {
      success: true,
      data: discoveryDocument,
    } satisfies ToolResult<AgentConfiguration>;
  }) as RelayAuthAdapter["discover"];

  t.after(() => {
    RelayAuthAdapter.prototype.discover = originalDiscover;
  });

  const tools = createRelayAuthTools(createConfig());
  const result = await tools.discover_service.execute({
    url: "https://override.example.test",
  });

  assert.deepEqual(result, {
    success: true,
    data: discoveryDocument,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://override.example.test");
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
});

test("register_agent delegates to adapter.registerAgent() with tool params", async (t) => {
  const originalRegisterAgent = RelayAuthAdapter.prototype.registerAgent;
  const calls: Array<{
    self: RelayAuthAdapter;
    name: string;
    scopes?: string[];
    sponsor?: string;
  }> = [];

  RelayAuthAdapter.prototype.registerAgent = (async function registerAgentSpy(
    this: RelayAuthAdapter,
    name,
    scopes,
    sponsor,
  ) {
    calls.push({ self: this, name, scopes, sponsor });
    return {
      success: true,
      data: {
        identity: {
          id: "agent_123",
        },
      },
    } as ToolResult;
  }) as RelayAuthAdapter["registerAgent"];

  t.after(() => {
    RelayAuthAdapter.prototype.registerAgent = originalRegisterAgent;
  });

  const tools = createRelayAuthTools(createConfig());
  const result = await tools.register_agent.execute({
    name: "billing-bot",
    scopes: ["relayauth:identity:read:*"],
    sponsor: "user_123",
  });

  assert.equal((result as ToolResult).success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "billing-bot");
  assert.deepEqual(calls[0]?.scopes, ["relayauth:identity:read:*"]);
  assert.equal(calls[0]?.sponsor, "user_123");
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
});

test("request_scope delegates to adapter.requestScope() with tool params", async (t) => {
  const originalRequestScope = RelayAuthAdapter.prototype.requestScope;
  const calls: Array<{
    self: RelayAuthAdapter;
    scopes: string[];
    identityId?: string;
  }> = [];

  RelayAuthAdapter.prototype.requestScope = (async function requestScopeSpy(
    this: RelayAuthAdapter,
    scopes,
    identityId,
  ) {
    calls.push({ self: this, scopes, identityId });
    return {
      success: true,
      data: {
        token: "issued_token_abc",
      },
    } as ToolResult;
  }) as RelayAuthAdapter["requestScope"];

  t.after(() => {
    RelayAuthAdapter.prototype.requestScope = originalRequestScope;
  });

  const tools = createRelayAuthTools(createConfig());
  const result = await tools.request_scope.execute({
    scopes: ["relaycast:channel:read:*"],
    identityId: "agent_456",
  });

  assert.equal((result as ToolResult).success, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.scopes, ["relaycast:channel:read:*"]);
  assert.equal(calls[0]?.identityId, "agent_456");
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
});

test("execute_with_auth proxies the request through RelayAuthAdapter and adds auth headers", async (t) => {
  const fetchMock = mockFetch(() =>
    jsonResponse({
      ok: true,
    }),
  );
  t.after(() => fetchMock.restore());

  const tools = createRelayAuthTools(createConfig());
  const result = await tools.execute_with_auth.execute({
    url: "https://api.example.test/run",
    method: "POST",
    body: {
      task: "sync",
    },
  });

  assert.deepEqual(result, {
    success: true,
    data: {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
      data: {
        ok: true,
      },
    },
  });
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), "https://api.example.test/run");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), `Bearer ${accessToken}`);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal(request.body, JSON.stringify({ task: "sync" }));
});

test("tools are structurally compatible with the Vercel AI SDK tool() contract", () => {
  const tools = createRelayAuthTools(createConfig());

  assertCoreToolRecord(tools);

  const discover = tools.discover_service;
  const register = tools.register_agent;
  const execute = tools.execute_with_auth;
  const check = tools.check_scope;

  assert.equal(discover.parameters.safeParse({}).success, true);
  assert.equal(
    register.parameters.safeParse({
      name: "billing-bot",
      scopes: ["relayauth:identity:read:*"],
      sponsor: "user_123",
    }).success,
    true,
  );
  assert.equal(
    execute.parameters.safeParse({
      url: "https://api.example.test/run",
      method: "POST",
      body: { task: "sync" },
    }).success,
    true,
  );
  assert.equal(check.parameters.safeParse({ scope: "relaycast:channel:read:general" }).success, true);
});

test("tool execute returns an error ToolResult instead of throwing when the adapter throws", async (t) => {
  const originalDiscover = RelayAuthAdapter.prototype.discover;

  RelayAuthAdapter.prototype.discover = (async function discoverFailure() {
    throw new Error("boom");
  }) as RelayAuthAdapter["discover"];

  t.after(() => {
    RelayAuthAdapter.prototype.discover = originalDiscover;
  });

  const tools = createRelayAuthTools(createConfig());

  await assert.doesNotReject(async () => {
    const result = await tools.discover_service.execute({});
    assert.deepEqual(result, {
      success: false,
      error: "boom",
    });
  });
});
