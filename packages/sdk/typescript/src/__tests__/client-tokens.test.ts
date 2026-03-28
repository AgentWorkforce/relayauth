import assert from "node:assert/strict";
import { test, onTestFinished } from "vitest";
import type { RelayAuthTokenClaims, TokenPair } from "@relayauth/types";
import { RelayAuthClient } from "../client.js";
import { IdentityNotFoundError, TokenExpiredError, TokenRevokedError } from "../errors.js";

type TokenIssueOptions = {
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
};

type TokenClient = RelayAuthClient & {
  issueToken(identityId: string, options?: TokenIssueOptions): Promise<TokenPair>;
  refreshToken(refreshToken: string): Promise<TokenPair>;
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

test("issueToken posts identityId and options to /v1/tokens", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(tokenPair, 201));
  onTestFinished(() => fetchMock.restore());

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

test("refreshToken posts the refresh token to /v1/tokens/refresh", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(tokenPair));
  onTestFinished(() => fetchMock.restore());

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

test("revokeToken posts tokenId to /v1/tokens/revoke and returns void", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
  onTestFinished(() => fetchMock.restore());

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

test("introspectToken sends token as a query param and returns claims", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(claims));
  onTestFinished(() => fetchMock.restore());

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

test("introspectToken returns null when the token is inactive", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(null));
  onTestFinished(() => fetchMock.restore());

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

test("refreshToken maps token_expired responses to TokenExpiredError", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "token_expired",
      },
      401,
    ),
  );
  onTestFinished(() => fetchMock.restore());

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

test("revokeToken maps token_revoked responses to TokenRevokedError", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "token_revoked",
      },
      401,
    ),
  );
  onTestFinished(() => fetchMock.restore());

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

test("issueToken maps invalid identities to IdentityNotFoundError", async () => {
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
  onTestFinished(() => fetchMock.restore());

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
