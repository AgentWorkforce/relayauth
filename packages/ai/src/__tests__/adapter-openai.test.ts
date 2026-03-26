import assert from "node:assert/strict";
import test from "node:test";

import { RelayAuthAdapter } from "../adapter.js";
import { RELAYAUTH_TOOLS } from "../tools.js";
import type { AdapterConfig, JSONSchema, ToolResult } from "../types.js";

type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
};

type OpenAIToolHandler = {
  tools: OpenAIFunctionTool[];
  handleToolCall: (name: string, args: string) => Promise<string>;
};

type OpenAIAdapterModule = {
  createOpenAITools: (config: AdapterConfig) => OpenAIFunctionTool[];
  createToolHandler: (config: AdapterConfig) => OpenAIToolHandler;
};

const baseUrl = "https://relay.example.test";
const accessToken = "adapter_access_token";

function createConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    serverUrl: baseUrl,
    apiKey: "test_api_key",
    token: accessToken,
    autoDiscover: false,
    ...overrides,
  };
}

async function loadOpenAIAdapter(): Promise<OpenAIAdapterModule> {
  return import("../adapters/openai.js") as Promise<OpenAIAdapterModule>;
}

function assertOpenAIFunctionTool(tool: OpenAIFunctionTool): void {
  assert.equal(tool.type, "function");
  assert.equal(typeof tool.function, "object");
  assert.notEqual(tool.function, null);
  assert.equal(typeof tool.function.name, "string");
  assert.notEqual(tool.function.name.length, 0);
  assert.equal(typeof tool.function.description, "string");
  assert.notEqual(tool.function.description.length, 0);
  assert.equal(typeof tool.function.parameters, "object");
  assert.notEqual(tool.function.parameters, null);
}

test("createOpenAITools returns a ChatCompletionTool-like array", async () => {
  const { createOpenAITools } = await loadOpenAIAdapter();
  const tools = createOpenAITools(createConfig());

  assert.equal(Array.isArray(tools), true);
  assert.ok(tools.length >= RELAYAUTH_TOOLS.length);

  const names = tools.map((tool) => tool.function.name);
  for (const definition of RELAYAUTH_TOOLS) {
    assert.ok(names.includes(definition.name), `expected ${definition.name} to be exposed`);
  }
});

test("each tool exposes OpenAI function metadata with JSON Schema parameters", async () => {
  const { createOpenAITools } = await loadOpenAIAdapter();
  const tools = createOpenAITools(createConfig());

  for (const tool of tools) {
    assertOpenAIFunctionTool(tool);

    const definition = RELAYAUTH_TOOLS.find((candidate) => candidate.name === tool.function.name);
    assert.ok(definition, `unexpected tool ${tool.function.name}`);
    assert.equal(tool.function.description, definition.description);
    assert.deepEqual(tool.function.parameters, definition.parameters);
    assert.equal("parse" in tool.function.parameters, false);
    assert.equal("safeParse" in tool.function.parameters, false);
  }
});

test("handleToolCall routes discover_service to adapter.discover() and returns a JSON string", async (t) => {
  const { createToolHandler } = await loadOpenAIAdapter();
  const originalMethod = RelayAuthAdapter.prototype.discover;
  const calls: Array<{ self: RelayAuthAdapter; args: [string | undefined] }> = [];
  const expected = {
    success: true,
    data: {
      issuer: baseUrl,
    },
  } satisfies ToolResult;

  RelayAuthAdapter.prototype.discover = (async function discoverSpy(this: RelayAuthAdapter, url?) {
    calls.push({ self: this, args: [url] });
    return expected;
  }) as RelayAuthAdapter["discover"];

  t.after(() => {
    RelayAuthAdapter.prototype.discover = originalMethod;
  });

  const { handleToolCall } = createToolHandler(createConfig());
  const result = await handleToolCall("discover_service", JSON.stringify({
    url: "https://override.example.test",
  }));

  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), expected);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, ["https://override.example.test"]);
});

test("handleToolCall routes register_agent to adapter.registerAgent()", async (t) => {
  const { createToolHandler } = await loadOpenAIAdapter();
  const originalMethod = RelayAuthAdapter.prototype.registerAgent;
  const calls: Array<{ self: RelayAuthAdapter; args: [string, string[] | undefined, string | undefined] }> = [];
  const expected = {
    success: true,
    data: {
      identity: {
        id: "agent_123",
      },
    },
  } satisfies ToolResult;

  RelayAuthAdapter.prototype.registerAgent = (async function registerAgentSpy(
    this: RelayAuthAdapter,
    name,
    scopes,
    sponsor,
  ) {
    calls.push({ self: this, args: [name, scopes, sponsor] });
    return expected;
  }) as RelayAuthAdapter["registerAgent"];

  t.after(() => {
    RelayAuthAdapter.prototype.registerAgent = originalMethod;
  });

  const { handleToolCall } = createToolHandler(createConfig());
  const result = await handleToolCall("register_agent", JSON.stringify({
    name: "billing-bot",
    scopes: ["relayauth:identity:read:*"],
    sponsor: "user_123",
  }));

  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), expected);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, [
    "billing-bot",
    ["relayauth:identity:read:*"],
    "user_123",
  ]);
});

test("handleToolCall routes request_scope to adapter.requestScope()", async (t) => {
  const { createToolHandler } = await loadOpenAIAdapter();
  const originalMethod = RelayAuthAdapter.prototype.requestScope;
  const calls: Array<{ self: RelayAuthAdapter; args: [string[], string | undefined] }> = [];
  const expected = {
    success: true,
    data: {
      identityId: "agent_123",
      scopes: ["relayauth:token:issue:*"],
      token: {
        accessToken: "issued_access_token",
        refreshToken: "issued_refresh_token",
        accessTokenExpiresAt: "2026-03-25T12:00:00.000Z",
        refreshTokenExpiresAt: "2026-04-24T12:00:00.000Z",
        tokenType: "Bearer",
      },
    },
  } satisfies ToolResult;

  RelayAuthAdapter.prototype.requestScope = (async function requestScopeSpy(
    this: RelayAuthAdapter,
    scopes,
    identityId,
  ) {
    calls.push({ self: this, args: [scopes, identityId] });
    return expected;
  }) as RelayAuthAdapter["requestScope"];

  t.after(() => {
    RelayAuthAdapter.prototype.requestScope = originalMethod;
  });

  const { handleToolCall } = createToolHandler(createConfig());
  const result = await handleToolCall("request_scope", JSON.stringify({
    scopes: ["relayauth:token:issue:*"],
    identityId: "agent_123",
  }));

  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), expected);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, [["relayauth:token:issue:*"], "agent_123"]);
});

test("handleToolCall routes execute_with_auth to adapter.executeWithAuth()", async (t) => {
  const { createToolHandler } = await loadOpenAIAdapter();
  const originalMethod = RelayAuthAdapter.prototype.executeWithAuth;
  const calls: Array<{
    self: RelayAuthAdapter;
    args: [string, "GET" | "POST" | "PUT" | "PATCH" | "DELETE", unknown, HeadersInit | undefined];
  }> = [];
  const expected = {
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
  } satisfies ToolResult;

  RelayAuthAdapter.prototype.executeWithAuth = (async function executeWithAuthSpy(
    this: RelayAuthAdapter,
    url,
    method,
    body,
    headers,
  ) {
    calls.push({ self: this, args: [url, method ?? "GET", body, headers] });
    return expected;
  }) as RelayAuthAdapter["executeWithAuth"];

  t.after(() => {
    RelayAuthAdapter.prototype.executeWithAuth = originalMethod;
  });

  const { handleToolCall } = createToolHandler(createConfig());
  const result = await handleToolCall("execute_with_auth", JSON.stringify({
    url: "https://service.example.test/resource",
    method: "POST",
    body: { enabled: true },
    headers: {
      "x-trace-id": "trace_123",
    },
  }));

  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), expected);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, [
    "https://service.example.test/resource",
    "POST",
    { enabled: true },
    { "x-trace-id": "trace_123" },
  ]);
});

test("handleToolCall routes check_scope to adapter.checkScope()", async (t) => {
  const { createToolHandler } = await loadOpenAIAdapter();
  const originalMethod = RelayAuthAdapter.prototype.checkScope;
  const calls: Array<{ self: RelayAuthAdapter; args: [string] }> = [];
  const expected = {
    success: true,
    data: {
      granted: true,
      scope: "relayauth:identity:read:*",
    },
  } satisfies ToolResult;

  RelayAuthAdapter.prototype.checkScope = (async function checkScopeSpy(
    this: RelayAuthAdapter,
    scope,
  ) {
    calls.push({ self: this, args: [scope] });
    return expected;
  }) as RelayAuthAdapter["checkScope"];

  t.after(() => {
    RelayAuthAdapter.prototype.checkScope = originalMethod;
  });

  const { handleToolCall } = createToolHandler(createConfig());
  const result = await handleToolCall("check_scope", JSON.stringify({
    scope: "relayauth:identity:read:*",
  }));

  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), expected);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, ["relayauth:identity:read:*"]);
});

test("unknown tool names return a serialized error ToolResult", async () => {
  const { createToolHandler } = await loadOpenAIAdapter();
  const { handleToolCall } = createToolHandler(createConfig());
  const result = await handleToolCall("unknown_tool", JSON.stringify({}));

  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), {
    success: false,
    error: "Unknown tool: unknown_tool",
  });
});

test("createToolHandler returns the tools array and handleToolCall bundle", async () => {
  const { createOpenAITools, createToolHandler } = await loadOpenAIAdapter();
  const bundle = createToolHandler(createConfig());
  const tools = createOpenAITools(createConfig());

  assert.equal(Array.isArray(bundle.tools), true);
  assert.equal(typeof bundle.handleToolCall, "function");
  assert.deepEqual(bundle.tools, tools);
});
