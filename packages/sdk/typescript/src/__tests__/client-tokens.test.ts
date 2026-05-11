import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentTokenPair,
  AgentTokenIssueRequest,
  PathTokenIssueRequest,
  RelayAuthTokenClaims,
  TokenPair,
  WorkspaceTokenIssueResponse,
} from "@relayauth/types";
import { RelayAuthClient } from "../client.js";
import { AgentTokenSession } from "../agent-token-session.js";
import {
  IdentityNotFoundError,
  RelayAuthError,
  TokenExpiredError,
  TokenRevokedError,
  WorkspaceTokenRevokedError,
} from "../errors.js";

type TokenIssueOptions = {
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
};

type TokenClient = RelayAuthClient & {
  issueToken(identityId: string, options?: TokenIssueOptions): Promise<TokenPair>;
  refreshToken(refreshToken: string): Promise<TokenPair>;
  issueWorkspaceToken(options: {
    workspaceId: string;
    name?: string;
    scopes?: string[];
  }): Promise<WorkspaceTokenIssueResponse>;
  issueAgentToken(options: {
    agentId: string;
    scopes?: string[];
    audience?: string[];
    expiresIn?: number;
  }): Promise<AgentTokenPair>;
  issuePathToken(options: {
    agentId: string;
    paths: string[];
    scopes?: string[];
    audience?: string[];
    expiresIn?: number;
  }): Promise<never>;
  revokeToken(tokenId: string): Promise<void>;
  introspectToken(token: string): Promise<RelayAuthTokenClaims | null>;
};

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const token = "sdk_test_token";
const baseUrl = "https://relay.example.test";

const tokenPair: TokenPair = {
  accessToken: "access_token_123",
  refreshToken: "refresh_token_123",
  accessTokenExpiresAt: "2026-03-25T11:00:00.000Z",
  refreshTokenExpiresAt: "2026-04-01T10:00:00.000Z",
  tokenType: "Bearer",
};

const claims: RelayAuthTokenClaims = {
  sub: "agent_123",
  org: "org_123",
  wks: "ws_123",
  scopes: ["relayauth:token:issue", "relayauth:identity:read"],
  sponsorId: "user_123",
  sponsorChain: ["user_123", "svc_gateway"],
  token_type: "access",
  iss: "https://relay.example.test",
  aud: ["relay-api", "worker-runtime"],
  exp: 1774436400,
  iat: 1774432800,
  jti: "jti_123",
  nbf: 1774432800,
  sid: "sid_123",
  meta: {
    env: "test",
  },
  parentTokenId: "parent_jti_123",
  budget: {
    maxActionsPerHour: 500,
    maxCostPerDay: 25,
    remaining: 412,
  },
};

const workspaceTokenResponse: WorkspaceTokenIssueResponse = {
  workspaceToken: {
    id: "ak_workspace_123",
    kind: "workspace_token",
    workspaceId: "ws_123",
    prefix: "relay_ws_abcd",
    name: "support-runtime",
    scopes: ["relayauth:token:create:*"],
    createdAt: "2026-03-25T10:00:00.000Z",
    revoked: false,
  },
  key: "relay_ws_abcdefghijklmnopqrstuvwxyz",
};

const agentTokenPair: AgentTokenPair = {
  ...tokenPair,
  accessToken: "relay_ag_access.token.value",
  refreshToken: "relay_ag_refresh.token.value",
  agentId: "agent_123",
  workspaceId: "ws_123",
  tokenClass: "relay_ag",
  issuedViaWorkspaceTokenId: "ak_workspace_123",
};

const rotatedAgentTokenPair: TokenPair = {
  ...tokenPair,
  accessToken: "relay_ag_rotated.access.token",
  refreshToken: "relay_ag_rotated.refresh.token",
  accessTokenExpiresAt: "2026-03-25T12:00:00.000Z",
  refreshTokenExpiresAt: "2026-04-01T12:00:00.000Z",
};

function createClient(): TokenClient {
  return new RelayAuthClient({ baseUrl, token }) as TokenClient;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function toUrl(input: RequestInfo | URL): URL {
  return typeof input === "string"
    ? new URL(input)
    : input instanceof URL
      ? new URL(input.toString())
      : new URL(input.url);
}

function mockFetch(responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
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

async function inspectCall(call: FetchCall): Promise<{
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}> {
  const url =
    typeof call.input === "string"
      ? new URL(call.input)
      : call.input instanceof URL
        ? new URL(call.input.toString())
        : new URL(call.input.url);

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

function assertBearer(headers: Headers): void {
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
}

test("issueToken posts identityId and options to /v1/tokens", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(tokenPair, 201));
  t.after(() => fetchMock.restore());

  const result = await client.issueToken("agent_123", {
    scopes: ["relayauth:identity:read", "relayauth:token:refresh"],
    audience: ["relay-api", "worker-runtime"],
    expiresIn: 3600,
  });

  assert.deepEqual(result, tokenPair);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/tokens`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    identityId: "agent_123",
    scopes: ["relayauth:identity:read", "relayauth:token:refresh"],
    audience: ["relay-api", "worker-runtime"],
    expiresIn: 3600,
  });
});

test("refreshToken posts the refresh token to /v1/tokens/refresh", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(tokenPair));
  t.after(() => fetchMock.restore());

  const result = await client.refreshToken(tokenPair.refreshToken);

  assert.deepEqual(result, tokenPair);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/tokens/refresh`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    refreshToken: tokenPair.refreshToken,
  });
});

test("issueWorkspaceToken posts workspace settings to /v1/tokens/workspace", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(workspaceTokenResponse, 201));
  t.after(() => fetchMock.restore());

  const result = await client.issueWorkspaceToken({
    workspaceId: "ws_123",
    name: "support-runtime",
    scopes: ["relayauth:token:create:*"],
  });

  assert.deepEqual(result, workspaceTokenResponse);
  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/tokens/workspace`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.deepEqual(JSON.parse(request.body), {
    workspaceId: "ws_123",
    name: "support-runtime",
    scopes: ["relayauth:token:create:*"],
  });
});

test("issueAgentToken uses x-api-key and posts the agent exchange request", async (t) => {
  const client = new RelayAuthClient({ baseUrl, apiKey: workspaceTokenResponse.key }) as TokenClient;
  const fetchMock = mockFetch(() => jsonResponse(agentTokenPair, 201));
  t.after(() => fetchMock.restore());

  const result = await client.issueAgentToken({
    agentId: "agent_123",
    scopes: ["relayauth:role:read:*"],
    audience: ["relayauth"],
    expiresIn: 1800,
  });

  assert.deepEqual(result, agentTokenPair);
  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/tokens/agent`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("x-api-key"), workspaceTokenResponse.key);
  assert.equal(request.headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(request.body), {
    agentId: "agent_123",
    scopes: ["relayauth:role:read:*"],
    audience: ["relayauth"],
    expiresIn: 1800,
  });
});

test("issuePathToken sends the future path-scoped request shape and surfaces the M1 501 stub", async (t) => {
  const client = new RelayAuthClient({ baseUrl, apiKey: workspaceTokenResponse.key }) as TokenClient;
  const requestBody: PathTokenIssueRequest = {
    agentId: "agent_123",
    paths: ["/linear/issues/**", "/github/repos/acme/api/**"],
    scopes: ["relayfile:fs:read:/linear/issues/**"],
    audience: ["relayfile"],
    expiresIn: 1800,
  };
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "path_scoped_tokens_not_implemented",
        code: "not_implemented",
      },
      501,
    ));
  t.after(() => fetchMock.restore());

  await assert.rejects(
    client.issuePathToken(requestBody),
    (error: unknown) => {
      assert.ok(error instanceof RelayAuthError);
      assert.equal(error.code, "not_implemented");
      assert.equal(error.statusCode, 501);
      return true;
    },
  );

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/tokens/path`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("x-api-key"), workspaceTokenResponse.key);
  assert.equal(request.headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(request.body), requestBody);
});

test("AgentTokenSession issues once, refreshes near access expiry, and preserves agent metadata", async (t) => {
  const client = new RelayAuthClient({ baseUrl, apiKey: workspaceTokenResponse.key });
  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);
    if (url.pathname === "/v1/tokens/agent") {
      return jsonResponse({
        ...agentTokenPair,
        accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, 201);
    }

    if (url.pathname === "/v1/tokens/refresh") {
      return jsonResponse({
        ...rotatedAgentTokenPair,
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
    }

    return jsonResponse({ error: "unexpected_request" }, 500);
  });
  t.after(() => fetchMock.restore());

  const session = new AgentTokenSession({
    client,
    agentId: "agent_123",
    scopes: ["relayauth:role:read:*"],
    audience: ["relayauth"],
  });

  const first = await session.getTokenPair();
  const second = await session.getTokenPair();

  assert.equal(first.accessToken, agentTokenPair.accessToken);
  assert.equal(second.accessToken, rotatedAgentTokenPair.accessToken);
  assert.equal(second.agentId, agentTokenPair.agentId);
  assert.equal(second.workspaceId, agentTokenPair.workspaceId);
  assert.equal(second.issuedViaWorkspaceTokenId, agentTokenPair.issuedViaWorkspaceTokenId);
  assert.equal(fetchMock.calls.length, 2);

  const firstRequest = await inspectCall(fetchMock.calls[0]);
  assert.equal(firstRequest.url.pathname, "/v1/tokens/agent");
  const secondRequest = await inspectCall(fetchMock.calls[1]);
  assert.equal(secondRequest.url.pathname, "/v1/tokens/refresh");
  assert.deepEqual(JSON.parse(secondRequest.body), {
    refreshToken: agentTokenPair.refreshToken,
  });
});

test("AgentTokenSession re-issues through the workspace token when refresh is revoked", async (t) => {
  const client = new RelayAuthClient({ baseUrl, apiKey: workspaceTokenResponse.key });
  let issueCount = 0;
  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);
    if (url.pathname === "/v1/tokens/agent") {
      issueCount += 1;
      return jsonResponse({
        ...agentTokenPair,
        accessToken: issueCount === 1 ? "relay_ag_initial.access" : "relay_ag_reissued.access",
        refreshToken: issueCount === 1 ? "relay_ag_initial.refresh" : "relay_ag_reissued.refresh",
        accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, 201);
    }

    if (url.pathname === "/v1/tokens/refresh") {
      return jsonResponse({ error: "token_revoked" }, 401);
    }

    return jsonResponse({ error: "unexpected_request" }, 500);
  });
  t.after(() => fetchMock.restore());

  const session = new AgentTokenSession({
    client,
    agentId: "agent_123",
  });

  const first = await session.getTokenPair();
  const second = await session.forceRefresh();

  assert.equal(first.accessToken, "relay_ag_initial.access");
  assert.equal(second.accessToken, "relay_ag_reissued.access");
  assert.equal(second.agentId, agentTokenPair.agentId);
  assert.equal(fetchMock.calls.length, 3);
  assert.equal((await inspectCall(fetchMock.calls[1])).url.pathname, "/v1/tokens/refresh");
  assert.equal((await inspectCall(fetchMock.calls[2])).url.pathname, "/v1/tokens/agent");
});

test("AgentTokenSession surfaces workspace-token revocation without silently re-issuing", async (t) => {
  const client = new RelayAuthClient({ baseUrl, apiKey: workspaceTokenResponse.key });
  const fetchMock = mockFetch((input) => {
    const url = toUrl(input);
    if (url.pathname === "/v1/tokens/agent") {
      return jsonResponse({
        ...agentTokenPair,
        accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, 201);
    }

    if (url.pathname === "/v1/tokens/refresh") {
      return jsonResponse({
        error: "workspace_token_revoked",
      }, 401);
    }

    return jsonResponse({ error: "unexpected_request" }, 500);
  });
  t.after(() => fetchMock.restore());

  const session = new AgentTokenSession({
    client,
    agentId: "agent_123",
  });

  await session.getTokenPair();

  await assert.rejects(
    session.forceRefresh(),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceTokenRevokedError);
      assert.equal(error.code, "workspace_token_revoked");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );

  assert.equal(fetchMock.calls.length, 2);
  assert.equal((await inspectCall(fetchMock.calls[0])).url.pathname, "/v1/tokens/agent");
  assert.equal((await inspectCall(fetchMock.calls[1])).url.pathname, "/v1/tokens/refresh");
});

test("revokeToken posts tokenId to /v1/tokens/revoke and returns void", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
  t.after(() => fetchMock.restore());

  const result = await client.revokeToken("tok_123");

  assert.equal(result, undefined);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/tokens/revoke`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    tokenId: "tok_123",
  });
});

test("introspectToken sends token as a query param and returns claims", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(claims));
  t.after(() => fetchMock.restore());

  const result = await client.introspectToken(tokenPair.accessToken);

  assert.deepEqual(result, claims);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/tokens/introspect");
  assert.equal(request.url.searchParams.get("token"), tokenPair.accessToken);
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("introspectToken returns null when the token is inactive", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(null));
  t.after(() => fetchMock.restore());

  const result = await client.introspectToken("inactive_token");

  assert.equal(result, null);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/tokens/introspect");
  assert.equal(request.url.searchParams.get("token"), "inactive_token");
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("refreshToken maps token_expired responses to TokenExpiredError", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "token_expired",
      },
      401,
    ),
  );
  t.after(() => fetchMock.restore());

  await assert.rejects(
    client.refreshToken("expired_refresh_token"),
    (error: unknown) => {
      assert.ok(error instanceof TokenExpiredError);
      assert.equal(error.message, "Token has expired");
      assert.equal(error.code, "token_expired");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
});

test("revokeToken maps token_revoked responses to TokenRevokedError", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "token_revoked",
      },
      401,
    ),
  );
  t.after(() => fetchMock.restore());

  await assert.rejects(
    client.revokeToken("tok_revoked"),
    (error: unknown) => {
      assert.ok(error instanceof TokenRevokedError);
      assert.equal(error.message, "Token has been revoked");
      assert.equal(error.code, "token_revoked");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
});

test("refreshToken maps workspace_token_revoked responses to WorkspaceTokenRevokedError", async (t) => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "workspace_token_revoked",
      },
      401,
    ));
  t.after(() => fetchMock.restore());

  await assert.rejects(
    client.refreshToken("agent_refresh_token"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceTokenRevokedError);
      assert.equal(error.message, "Workspace token has been revoked");
      assert.equal(error.code, "workspace_token_revoked");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
});

test("issueToken maps invalid identities to IdentityNotFoundError", async (t) => {
  const client = createClient();
  const missingIdentityId = "agent_missing";
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "identity_not_found",
      },
      404,
    ),
  );
  t.after(() => fetchMock.restore());

  await assert.rejects(
    client.issueToken(missingIdentityId),
    (error: unknown) => {
      assert.ok(error instanceof IdentityNotFoundError);
      assert.equal(error.message, `Identity not found: ${missingIdentityId}`);
      assert.equal(error.code, "identity_not_found");
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});
