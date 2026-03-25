import assert from "node:assert/strict";
import test from "node:test";

import { RelayAuthAdapter } from "../adapter.js";
import { RELAYAUTH_TOOLS } from "../tools.js";
import type { AdapterConfig, JSONSchema, ToolResult } from "../types.js";

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: JSONSchema & {
    type: "object";
    properties: Record<string, JSONSchema>;
    required?: string[];
  };
};

type ToolResultBlockParam = {
  type: "text";
  text: string;
};

type AnthropicToolUseResult = {
  content: ToolResultBlockParam[];
  is_error?: boolean;
};

type AnthropicToolHandler = {
  tools: AnthropicTool[];
  handleToolUse: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<AnthropicToolUseResult>;
};

type AnthropicAdapterModule = {
  createAnthropicTools: (config: AdapterConfig) => AnthropicTool[];
  createToolHandler: (config: AdapterConfig) => AnthropicToolHandler;
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

async function loadAnthropicAdapter(): Promise<AnthropicAdapterModule> {
  return import("../adapters/anthropic.js") as Promise<AnthropicAdapterModule>;
}

function assertAnthropicTool(tool: AnthropicTool): void {
  assert.equal(typeof tool.name, "string");
  assert.notEqual(tool.name.length, 0);
  assert.equal(typeof tool.description, "string");
  assert.notEqual(tool.description.length, 0);
  assert.equal(typeof tool.input_schema, "object");
  assert.notEqual(tool.input_schema, null);
  assert.equal(tool.input_schema.type, "object");
  assert.equal(typeof tool.input_schema.properties, "object");
  assert.notEqual(tool.input_schema.properties, null);
}

function assertToolResultBlocks(result: AnthropicToolUseResult, expected: ToolResult): void {
  assert.equal(Array.isArray(result.content), true);
  assert.equal(result.content.length, 1);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: JSON.stringify(expected),
    },
  ]);
}

test("createAnthropicTools returns an Anthropic Tool[] array", async () => {
  const { createAnthropicTools } = await loadAnthropicAdapter();
  const tools = createAnthropicTools(createConfig());

  assert.equal(Array.isArray(tools), true);
  assert.ok(tools.length >= RELAYAUTH_TOOLS.length);

  const names = tools.map((tool) => tool.name);
  for (const definition of RELAYAUTH_TOOLS) {
    assert.ok(names.includes(definition.name), `expected ${definition.name} to be exposed`);
  }
});

test("each tool exposes Anthropic metadata with name, description, and input_schema", async () => {
  const { createAnthropicTools } = await loadAnthropicAdapter();
  const tools = createAnthropicTools(createConfig());

  for (const tool of tools) {
    assertAnthropicTool(tool);

    const definition = RELAYAUTH_TOOLS.find((candidate) => candidate.name === tool.name);
    assert.ok(definition, `unexpected tool ${tool.name}`);
    assert.equal(tool.description, definition.description);
    assert.deepEqual(tool.input_schema, definition.parameters);
  }
});

test("input_schema uses Anthropic's JSON Schema object format", async () => {
  const { createAnthropicTools } = await loadAnthropicAdapter();
  const tools = createAnthropicTools(createConfig());

  for (const tool of tools) {
    assert.equal(tool.input_schema.type, "object");
    assert.equal(typeof tool.input_schema.properties, "object");
    assert.notEqual(tool.input_schema.properties, null);

    const definition = RELAYAUTH_TOOLS.find((candidate) => candidate.name === tool.name);
    assert.ok(definition, `unexpected tool ${tool.name}`);
    assert.deepEqual(tool.input_schema.required ?? [], definition.parameters.required ?? []);
    assert.equal("parse" in tool.input_schema, false);
    assert.equal("safeParse" in tool.input_schema, false);
  }
});

test("handleToolUse routes discover_service to adapter.discover()", async (t) => {
  const { createToolHandler } = await loadAnthropicAdapter();
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

  const { handleToolUse } = createToolHandler(createConfig());
  const result = await handleToolUse("discover_service", {
    url: "https://override.example.test",
  });

  assertToolResultBlocks(result, expected);
  assert.equal(result.is_error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, ["https://override.example.test"]);
});

test("handleToolUse routes register_agent to adapter.registerAgent()", async (t) => {
  const { createToolHandler } = await loadAnthropicAdapter();
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

  const { handleToolUse } = createToolHandler(createConfig());
  const result = await handleToolUse("register_agent", {
    name: "billing-bot",
    scopes: ["relayauth:identity:read:*"],
    sponsor: "user_123",
  });

  assertToolResultBlocks(result, expected);
  assert.equal(result.is_error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, [
    "billing-bot",
    ["relayauth:identity:read:*"],
    "user_123",
  ]);
});

test("handleToolUse routes request_scope to adapter.requestScope()", async (t) => {
  const { createToolHandler } = await loadAnthropicAdapter();
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

  const { handleToolUse } = createToolHandler(createConfig());
  const result = await handleToolUse("request_scope", {
    scopes: ["relayauth:token:issue:*"],
    identityId: "agent_123",
  });

  assertToolResultBlocks(result, expected);
  assert.equal(result.is_error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, [["relayauth:token:issue:*"], "agent_123"]);
});

test("handleToolUse routes execute_with_auth to adapter.executeWithAuth()", async (t) => {
  const { createToolHandler } = await loadAnthropicAdapter();
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

  const { handleToolUse } = createToolHandler(createConfig());
  const result = await handleToolUse("execute_with_auth", {
    url: "https://service.example.test/resource",
    method: "POST",
    body: { enabled: true },
    headers: {
      "x-trace-id": "trace_123",
    },
  });

  assertToolResultBlocks(result, expected);
  assert.equal(result.is_error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, [
    "https://service.example.test/resource",
    "POST",
    { enabled: true },
    { "x-trace-id": "trace_123" },
  ]);
});

test("handleToolUse routes check_scope to adapter.checkScope()", async (t) => {
  const { createToolHandler } = await loadAnthropicAdapter();
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

  const { handleToolUse } = createToolHandler(createConfig());
  const result = await handleToolUse("check_scope", {
    scope: "relayauth:identity:read:*",
  });

  assertToolResultBlocks(result, expected);
  assert.equal(result.is_error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.self instanceof RelayAuthAdapter);
  assert.deepEqual(calls[0]?.args, ["relayauth:identity:read:*"]);
});

test("handleToolUse returns content blocks with is_error: true for unsuccessful tool results", async (t) => {
  const { createToolHandler } = await loadAnthropicAdapter();
  const originalMethod = RelayAuthAdapter.prototype.checkScope;
  const expected = {
    success: false,
    error: "scope denied",
  } satisfies ToolResult;

  RelayAuthAdapter.prototype.checkScope = (async function checkScopeSpy() {
    return expected;
  }) as RelayAuthAdapter["checkScope"];

  t.after(() => {
    RelayAuthAdapter.prototype.checkScope = originalMethod;
  });

  const { handleToolUse } = createToolHandler(createConfig());
  const result = await handleToolUse("check_scope", {
    scope: "relayauth:identity:read:*",
  });

  assert.equal(result.is_error, true);
  assertToolResultBlocks(result, expected);
});

test("createToolHandler returns the tools array and handleToolUse bundle", async () => {
  const { createAnthropicTools, createToolHandler } = await loadAnthropicAdapter();
  const bundle = createToolHandler(createConfig());
  const tools = createAnthropicTools(createConfig());

  assert.equal(Array.isArray(bundle.tools), true);
  assert.equal(typeof bundle.handleToolUse, "function");
  assert.deepEqual(bundle.tools, tools);
});
