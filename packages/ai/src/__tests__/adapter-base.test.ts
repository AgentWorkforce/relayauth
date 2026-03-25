import assert from "node:assert/strict";
import test from "node:test";

import type { AgentConfiguration, AgentIdentity, RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthAdapter } from "../adapter.js";
import type { AdapterConfig, AdapterTool } from "../types.js";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const baseUrl = "https://relay.example.test";
const jwksUrl = `${baseUrl}/.well-known/jwks.json`;
const accessToken = "adapter_access_token";

const discoveryDocument: AgentConfiguration = {
  schema_version: "1.0",
  issuer: baseUrl,
  service_name: "RelayAuth Test",
  jwks_uri: jwksUrl,
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

const createdIdentity: AgentIdentity = {
  id: "agent_123",
  name: "billing-bot",
  type: "agent",
  orgId: "org_123",
  status: "active",
  scopes: ["relayauth:identity:read:*"],
  roles: [],
  metadata: { sponsor: "user_123" },
  createdAt: "2026-03-25T12:00:00.000Z",
  updatedAt: "2026-03-25T12:00:00.000Z",
};

function createConfig(
  overrides: Partial<AdapterConfig> = {},
  extra: Record<string, unknown> = {},
): AdapterConfig {
  return {
    serverUrl: baseUrl,
    apiKey: "test_api_key",
    token: accessToken,
    jwksUrl,
    issuer: baseUrl,
    audience: ["relayauth:test"],
    defaultScopes: ["relayauth:identity:read:*"],
    ...overrides,
    ...extra,
  } as AdapterConfig;
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
  const url =
    toUrl(call.input);

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

function normalizeToolName(name: string): string {
  return name.replace(/^relayauth_/, "");
}

function assertToolDefinition(tool: AdapterTool): void {
  assert.equal(typeof tool.name, "string");
  assert.notEqual(tool.name.length, 0);
  assert.equal(typeof tool.description, "string");
  assert.notEqual(tool.description.length, 0);
  assert.equal(typeof tool.parameters, "object");
  assert.notEqual(tool.parameters, null);
  assert.equal(Array.isArray(tool.parameters), false);
  const schema = tool.parameters as Record<string, unknown>;
  assert.ok(
    "type" in schema || "properties" in schema,
    "tool.parameters should look like a JSON Schema object",
  );
}

function buildClaims(scopes: string[]): RelayAuthTokenClaims {
  return {
    sub: "agent_123",
    org: "org_123",
    wks: "ws_123",
    scopes,
    sponsorId: "user_123",
    sponsorChain: ["user_123", "agent_123"],
    token_type: "access",
    iss: baseUrl,
    aud: ["relayauth:test"],
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 60,
    jti: "jti_123",
  };
}

async function createSignedRs256Token(
  claims: RelayAuthTokenClaims,
): Promise<{ token: string; publicJwk: JsonWebKey }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const header = {
    alg: "RS256",
    kid: "test-kid",
    typ: "JWT",
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(claims));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(unsignedToken),
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "test-kid";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  return {
    token: `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`,
    publicJwk,
  };
}

function encodeBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

function getGrantedValue(result: unknown): boolean {
  const unwrapped = unwrapResultData(result);

  if (typeof unwrapped === "boolean") {
    return unwrapped;
  }

  if (unwrapped && typeof unwrapped === "object" && "granted" in unwrapped) {
    return Boolean((unwrapped as { granted?: unknown }).granted);
  }

  assert.fail("checkScope() should return a boolean or an object with a granted field");
}

function unwrapResultData<T>(result: T): unknown {
  if (
    result
    && typeof result === "object"
    && "success" in result
    && "data" in result
  ) {
    return (result as { data?: unknown }).data;
  }

  return result;
}

test("RelayAuthAdapter constructor accepts config with serverUrl and options", () => {
  const config = createConfig({}, {
    options: {
      token: accessToken,
      jwksUrl,
      audience: ["relayauth:test"],
    },
  });

  const adapter = new RelayAuthAdapter(config);

  assert.ok(adapter instanceof RelayAuthAdapter);
});

test("getTools returns AdapterTool definitions for the standard RelayAuth tools", () => {
  const adapter = new RelayAuthAdapter(createConfig());

  const tools = adapter.getTools();

  assert.ok(Array.isArray(tools));
  assert.ok(tools.length >= 5);

  const normalizedNames = tools.map((tool) => normalizeToolName(tool.name));
  for (const expectedName of [
    "check_scope",
    "discover_service",
    "execute_with_auth",
    "register_agent",
    "request_scope",
  ]) {
    assert.ok(
      normalizedNames.includes(expectedName),
      `getTools() should include the ${expectedName} tool`,
    );
  }

  for (const tool of tools) {
    assertToolDefinition(tool);
  }
});

test("discover fetches /.well-known/agent-configuration", async (t) => {
  const adapter = new RelayAuthAdapter(createConfig());
  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);
    assert.equal(url.pathname, "/.well-known/agent-configuration");
    return jsonResponse(discoveryDocument);
  });
  t.after(() => fetchMock.restore());

  const result = await adapter.discover();

  assert.deepEqual(unwrapResultData(result), discoveryDocument);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.method, "GET");
  assert.equal(request.url.toString(), `${baseUrl}/.well-known/agent-configuration`);
});

test("registerAgent creates an identity via the SDK client's identity endpoint", async (t) => {
  const adapter = new RelayAuthAdapter(createConfig());
  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);

    if (url.pathname === "/.well-known/agent-configuration") {
      return jsonResponse(discoveryDocument);
    }

    if (url.pathname === "/v1/identities") {
      return jsonResponse(createdIdentity, 201);
    }

    if (url.pathname === "/v1/tokens") {
      return jsonResponse(
        {
          accessToken,
          refreshToken: "refresh_token",
          accessTokenExpiresAt: "2026-03-26T12:00:00.000Z",
          refreshTokenExpiresAt: "2026-04-24T12:00:00.000Z",
          tokenType: "Bearer",
        },
        201,
      );
    }

    assert.fail(`Unexpected fetch to ${url}`);
  });
  t.after(() => fetchMock.restore());

  const result = await adapter.registerAgent(
    "billing-bot",
    ["relayauth:identity:read:*"],
    "user_123",
  );

  assert.notEqual(result, undefined);
  assert.ok(fetchMock.calls.length >= 1);

  const identityCall = fetchMock.calls.find((call) => {
    const url = toUrl(call.input);
    return url.pathname === "/v1/identities";
  });

  assert.ok(identityCall, "registerAgent() should call the identity creation endpoint");

  const request = await inspectCall(identityCall!);
  assert.equal(request.method, "POST");
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities`);
  const payload = JSON.parse(request.body) as Record<string, unknown>;
  assert.equal(payload.name, "billing-bot");
});

test("requestScope uses the newly issued token after registerAgent rotates credentials", async (t) => {
  const adapter = new RelayAuthAdapter(createConfig());
  const fetchMock = mockFetch((input, init) => {
    const url = toUrl(input);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      for (const [name, value] of new Headers(init.headers).entries()) {
        headers.set(name, value);
      }
    }

    if (url.pathname === "/.well-known/agent-configuration") {
      return jsonResponse(discoveryDocument);
    }

    if (url.pathname === "/v1/identities") {
      assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
      return jsonResponse(createdIdentity, 201);
    }

    if (url.pathname === "/v1/tokens") {
      const body = init?.body ? JSON.parse(String(init.body)) as { identityId?: string; scopes?: string[] } : {};

      if (body.identityId === createdIdentity.id && Array.isArray(body.scopes) && body.scopes[0] === "relayauth:identity:read:*") {
        assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
        return jsonResponse(
          {
            accessToken: "agent_access_token",
            refreshToken: "refresh_token_1",
            accessTokenExpiresAt: "2026-03-26T12:00:00.000Z",
            refreshTokenExpiresAt: "2026-04-24T12:00:00.000Z",
            tokenType: "Bearer",
          },
          201,
        );
      }

      assert.equal(headers.get("authorization"), "Bearer agent_access_token");
      return jsonResponse(
        {
          accessToken: "scoped_access_token",
          refreshToken: "refresh_token_2",
          accessTokenExpiresAt: "2026-03-26T13:00:00.000Z",
          refreshTokenExpiresAt: "2026-04-24T13:00:00.000Z",
          tokenType: "Bearer",
        },
        201,
      );
    }

    assert.fail(`Unexpected fetch to ${url}`);
  });
  t.after(() => fetchMock.restore());

  await adapter.registerAgent("billing-bot", ["relayauth:identity:read:*"], "user_123");
  const result = await adapter.requestScope(["relayauth:identity:write:*"]);

  assert.notEqual(result, undefined);
});

test("discover retries after a transient discovery failure", async (t) => {
  const adapter = new RelayAuthAdapter(createConfig());
  let attempts = 0;
  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);
    assert.equal(url.pathname, "/.well-known/agent-configuration");
    attempts += 1;

    if (attempts === 1) {
      throw new Error("temporary network issue");
    }

    return jsonResponse(discoveryDocument);
  });
  t.after(() => fetchMock.restore());

  const first = await adapter.discover();
  assert.equal((first as { success?: boolean }).success, false);

  const second = await adapter.discover();
  assert.deepEqual(unwrapResultData(second), discoveryDocument);
  assert.equal(attempts, 2);
});

test("executeWithAuth adds the bearer token to outgoing request headers", async (t) => {
  const adapter = new RelayAuthAdapter(createConfig());
  const fetchMock = mockFetch(() =>
    jsonResponse({
      ok: true,
    }),
  );
  t.after(() => fetchMock.restore());

  const result = await adapter.executeWithAuth("https://api.example.test/run", "POST", {
    task: "sync",
  });

  assert.notEqual(result, undefined);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), "https://api.example.test/run");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), `Bearer ${accessToken}`);
});

test("checkScope uses ScopeChecker semantics when evaluating granted scopes", async (t) => {
  const { token, publicJwk } = await createSignedRs256Token(buildClaims(["relaycast:*:*:*"]));
  const adapter = new RelayAuthAdapter(
    createConfig(
      {
        token,
      },
      {
        options: {
          token,
          jwksUrl,
          issuer: baseUrl,
          audience: ["relayauth:test"],
        },
      },
    ),
  );

  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);

    if (url.pathname === "/.well-known/agent-configuration") {
      return jsonResponse(discoveryDocument);
    }

    assert.equal(url.toString(), jwksUrl);
    return jsonResponse({
      keys: [publicJwk],
    });
  });
  t.after(() => fetchMock.restore());

  const granted = await adapter.checkScope("relaycast:channel:read:general");
  const denied = await adapter.checkScope("relayfile:fs:write:/tmp");

  assert.equal(getGrantedValue(granted), true);
  assert.equal(getGrantedValue(denied), false);
  assert.ok(fetchMock.calls.length >= 1);
});
