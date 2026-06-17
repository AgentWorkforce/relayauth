import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type {
  AgentTokenPair,
  PathTokenPair,
  RelayAuthTokenClaims,
  TokenPair,
  WorkspacePathTokenPair,
  WorkspaceTokenIssueResponse,
} from "@relayauth/types";

import type { StoredIdentity } from "../storage/identity-types.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  listRevokedTokenIds,
  seedActiveTokens,
  seedStoredIdentity,
  seedWorkspaceContext,
  TEST_RS256_PRIVATE_KEY_PEM,
} from "./test-helpers.js";

type JwtHeader = {
  alg?: string;
  typ?: string;
  kid?: string;
};

type ErrorBody = {
  error?: string;
  code?: string;
  message?: string;
};

type ApiKeyCreateResponse = {
  key: string;
  apiKey: {
    id: string;
    scopes: string[];
  };
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signRs256Jwt(claims: RelayAuthTokenClaims): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), TEST_RS256_PRIVATE_KEY_PEM)
    .toString("base64url");

  return `${unsigned}.${signature}`;
}

function decodeJwtJsonSegment<T>(token: string, index: 0 | 1): T {
  const normalized = token.startsWith("relay_ag_")
    ? token.slice("relay_ag_".length)
    : token.startsWith("relay_pa_")
      ? token.slice("relay_pa_".length)
      : token;
  const segments = normalized.split(".");
  assert.equal(segments.length, 3, "expected a compact JWT with exactly three segments");
  return JSON.parse(Buffer.from(segments[index], "base64url").toString("utf8")) as T;
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_worker_owner";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, base.id],
    workspaceId: overrides.workspaceId ?? "ws_worker",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createAuthToken(overrides: Partial<RelayAuthTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const sponsorId = overrides.sponsorId ?? "user_admin_worker";
  const sub = overrides.sub ?? "agent_admin_worker";

  return signRs256Jwt({
    sub,
    org: overrides.org ?? "org_tokens_route",
    wks: overrides.wks ?? "ws_tokens_route",
    scopes: overrides.scopes ?? ["relayauth:token:create:*", "relayauth:token:manage:*", "relayauth:token:read:*"],
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, sub],
    token_type: overrides.token_type ?? "access",
    iss: overrides.iss ?? "https://relayauth.dev",
    aud: overrides.aud ?? ["relayauth"],
    exp: overrides.exp ?? now + 3600,
    iat: overrides.iat ?? now,
    jti: overrides.jti ?? `tok_${crypto.randomUUID().replace(/-/g, "")}`,
    ...(overrides.nbf !== undefined ? { nbf: overrides.nbf } : {}),
    ...(overrides.sid !== undefined ? { sid: overrides.sid } : {}),
    ...(overrides.meta !== undefined ? { meta: overrides.meta } : {}),
    ...(overrides.parentTokenId !== undefined ? { parentTokenId: overrides.parentTokenId } : {}),
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
  });
}

function createTokenClaims(
  identity: StoredIdentity,
  {
    tokenType,
    scopes,
    audience,
    expiresInSeconds,
    issuedAt,
    jti,
    sid,
  }: {
    tokenType: "access" | "refresh";
    scopes: string[];
    audience: string[];
    expiresInSeconds: number;
    issuedAt?: number;
    jti?: string;
    sid?: string;
  },
): RelayAuthTokenClaims {
  const iat = issuedAt ?? Math.floor(Date.now() / 1000);
  return {
    sub: identity.id,
    org: identity.orgId,
    wks: identity.workspaceId,
    scopes,
    sponsorId: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    token_type: tokenType,
    iss: "https://relayauth.dev",
    aud: audience,
    exp: iat + expiresInSeconds,
    iat,
    jti: jti ?? `tok_${crypto.randomUUID().replace(/-/g, "")}`,
    ...(sid ? { sid } : {}),
  };
}

function createRs256TokenPair(
  identity: StoredIdentity,
  {
    accessScopes = ["specialist:invoke"],
    audience = ["specialist"],
    accessExpiresInSeconds = 3600,
    refreshExpiresInSeconds = 24 * 3600,
    issuedAt,
  }: {
    accessScopes?: string[];
    audience?: string[];
    accessExpiresInSeconds?: number;
    refreshExpiresInSeconds?: number;
    issuedAt?: number;
  } = {},
): {
  pair: TokenPair;
  accessClaims: RelayAuthTokenClaims;
  refreshClaims: RelayAuthTokenClaims;
} {
  const now = issuedAt ?? Math.floor(Date.now() / 1000);
  const sid = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
  const accessClaims = createTokenClaims(identity, {
    tokenType: "access",
    scopes: accessScopes,
    audience,
    expiresInSeconds: accessExpiresInSeconds,
    issuedAt: now,
    sid,
  });
  const refreshClaims = createTokenClaims(identity, {
    tokenType: "refresh",
    scopes: ["relayauth:token:refresh"],
    audience: ["relayauth"],
    expiresInSeconds: refreshExpiresInSeconds,
    issuedAt: now,
    sid,
  });

  return {
    pair: {
      accessToken: signRs256Jwt(accessClaims),
      refreshToken: signRs256Jwt(refreshClaims),
      accessTokenExpiresAt: new Date(accessClaims.exp * 1000).toISOString(),
      refreshTokenExpiresAt: new Date(refreshClaims.exp * 1000).toISOString(),
      tokenType: "Bearer",
    },
    accessClaims,
    refreshClaims,
  };
}

function assertScopeFormat(scopes: string[], fieldName: string): void {
  assert.ok(scopes.length > 0, `${fieldName} should not be empty`);
  for (const scope of scopes) {
    assert.match(
      scope,
      /^[^:\s]+:[^:\s]+(?::[^:\s]+){0,2}$/,
      `${fieldName} entry ${JSON.stringify(scope)} must follow plane:action or plane:resource:action[:constraint]`,
    );
  }
}

function assertTokenClaimsMatchSpec(
  claims: RelayAuthTokenClaims,
  {
    tokenType,
    expectedIdentity,
    expectedAudience,
    expectedScopes,
  }: {
    tokenType: "access" | "refresh";
    expectedIdentity: StoredIdentity;
    expectedAudience: string[];
    expectedScopes: string[];
  },
): void {
  assert.equal(claims.sub, expectedIdentity.id);
  assert.match(claims.sub, /^agent_[A-Za-z0-9_-]+$/);
  assert.equal(claims.org, expectedIdentity.orgId);
  assert.match(claims.org, /^org_[A-Za-z0-9_-]+$/);
  assert.equal(claims.wks, expectedIdentity.workspaceId);
  assert.match(claims.wks, /^ws_[A-Za-z0-9_-]+$/);
  assert.deepEqual(claims.scopes, expectedScopes);
  assertScopeFormat(claims.scopes, "scopes");
  assert.equal(claims.sponsorId, expectedIdentity.sponsorId);
  assert.match(claims.sponsorId, /^user_[A-Za-z0-9_-]+$/);
  assert.deepEqual(claims.sponsorChain, expectedIdentity.sponsorChain);
  assert.ok(claims.sponsorChain.length >= 2, "sponsorChain should include sponsor and agent");
  assert.equal(claims.sponsorChain[0], claims.sponsorId);
  assert.equal(claims.sponsorChain.at(-1), claims.sub);
  assert.equal(claims.iss, "https://relayauth.dev");
  assert.deepEqual(claims.aud, expectedAudience);
  assert.ok(claims.aud.length > 0, "aud should not be empty");
  assert.equal(claims.token_type, tokenType);
  assert.match(claims.jti, /^tok_[A-Za-z0-9_-]+$/);
  assert.equal(typeof claims.iat, "number");
  assert.equal(typeof claims.exp, "number");
  assert.ok(claims.exp > claims.iat, "exp must be after iat");
  assert.equal("workspace_id" in claims, false, "RS256 workspace_id alias should not be present");
  assert.equal("agent_name" in claims, false, "RS256 agent_name alias should not be present");
  assert.equal("sponsor" in claims, false, "RS256 sponsor claim should not be present");

  if (tokenType === "refresh") {
    assert.deepEqual(claims.aud, ["relayauth"]);
  }
}

function assertRs256Algorithm(token: string, _audience?: string[]): void {
  const header = decodeJwtJsonSegment<JwtHeader>(token, 0);
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
}

async function createHarness({
  authClaims,
  identity,
}: {
  authClaims?: Partial<RelayAuthTokenClaims>;
  identity?: StoredIdentity;
} = {}) {
  const app = createTestApp();
  const storedIdentity = identity ?? createStoredIdentity({
    id: "agent_tokens_subject",
    name: "Tokens Subject",
    orgId: authClaims?.org ?? "org_tokens_route",
    workspaceId: authClaims?.wks ?? "ws_tokens_route",
    sponsorId: "user_tokens_owner",
    sponsorChain: ["user_tokens_owner", "agent_tokens_subject"],
    scopes: ["specialist:invoke"],
  });
  await seedStoredIdentity(app, storedIdentity);

  return {
    app,
    identity: storedIdentity,
    authHeaders: {
      Authorization: `Bearer ${createAuthToken({
        org: storedIdentity.orgId,
        wks: storedIdentity.workspaceId,
        ...authClaims,
      })}`,
    } satisfies HeadersInit,
  };
}

async function requestRoute(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  {
    body,
    headers,
  }: {
    body?: unknown;
    headers?: HeadersInit;
  } = {},
): Promise<Response> {
  const request = createTestRequest(method, path, body, headers);
  return app.request(request, undefined, app.bindings);
}

async function issueWorkspaceToken(
  app: ReturnType<typeof createTestApp>,
  headers: HeadersInit,
  {
    workspaceId = "ws_tokens_route",
    name = "runtime-support",
    scopes = ["relayauth:token:create:*", "relayauth:role:read:*"],
  }: {
    workspaceId?: string;
    name?: string;
    scopes?: string[];
  } = {},
): Promise<WorkspaceTokenIssueResponse> {
  const response = await requestRoute(app, "POST", "/v1/tokens/workspace", {
    body: {
      workspaceId,
      name,
      scopes,
    },
    headers,
  });

  return assertJsonResponse<WorkspaceTokenIssueResponse>(response, 201);
}

async function issueApiKey(
  app: ReturnType<typeof createTestApp>,
  headers: HeadersInit,
  scopes: string[],
): Promise<ApiKeyCreateResponse> {
  const response = await requestRoute(app, "POST", "/v1/api-keys", {
    body: {
      name: "workspace-path-direct-mint",
      scopes,
    },
    headers,
  });

  return assertJsonResponse<ApiKeyCreateResponse>(response, 201);
}

async function countStoredTokens(app: ReturnType<typeof createTestApp>): Promise<number> {
  const row = await app.storage.DB.prepare("SELECT COUNT(*) AS count FROM tokens").first<{ count: number }>();
  return Number(row?.count ?? 0);
}

test("POST /v1/tokens", async (t) => {
  await t.test("issues a Phase 0 RS256 token pair with token-format claim shape", async () => {
    const { app, identity, authHeaders } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: identity.id,
        scopes: ["specialist:invoke"],
        audience: ["specialist"],
        expiresIn: 3600,
      },
      headers: authHeaders,
    });

    const body = await assertJsonResponse<TokenPair>(response, 201);
    assert.equal(body.tokenType, "Bearer");
    assert.match(body.accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(body.refreshToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(Number.isNaN(Date.parse(body.accessTokenExpiresAt)), false);
    assert.equal(Number.isNaN(Date.parse(body.refreshTokenExpiresAt)), false);
    assert.ok(
      Date.parse(body.refreshTokenExpiresAt) > Date.parse(body.accessTokenExpiresAt),
      "refresh expiry should be after access expiry",
    );

    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    const refreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    assertTokenClaimsMatchSpec(accessClaims, {
      tokenType: "access",
      expectedIdentity: identity,
      expectedAudience: ["specialist"],
      expectedScopes: ["specialist:invoke"],
    });
    assertTokenClaimsMatchSpec(refreshClaims, {
      tokenType: "refresh",
      expectedIdentity: identity,
      expectedAudience: ["relayauth"],
      expectedScopes: ["relayauth:token:refresh"],
    });

    await assertRs256Algorithm(body.accessToken, ["specialist"]);
    await assertRs256Algorithm(body.refreshToken, ["relayauth"]);
  });

  await t.test("returns 401 when Authorization is missing", async () => {
    const { app, identity } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: { identityId: identity.id },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "missing_authorization");
    });
  });

  await t.test("returns 401 when Authorization is malformed", async () => {
    const { app, identity } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: { identityId: identity.id },
      headers: {
        Authorization: "Basic not-a-bearer-token",
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "invalid_authorization");
    });
  });

  await t.test("returns 400 when identityId is missing from the request body", async () => {
    const { app, authHeaders } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        scopes: ["specialist:invoke"],
        audience: ["specialist"],
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 400, (body) => {
      assert.match(JSON.stringify(body), /identityId/i);
    });
  });

  await t.test("returns 404 when the requested identity does not exist", async () => {
    const { app, authHeaders } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: "agent_missing_for_tokens",
        scopes: ["specialist:invoke"],
        audience: ["specialist"],
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 404, (body) => {
      assert.match(JSON.stringify(body), /identity|not[_ -]?found/i);
    });
  });

  await t.test("returns 403 when requested scopes exceed the target identity grant", async () => {
    const { app, identity, authHeaders } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: identity.id,
        scopes: ["relayauth:identity:manage:*"],
        audience: ["relayauth"],
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 403, (body) => {
      assert.equal(body.error, "insufficient_scope");
    });
  });
});

test("POST /v1/tokens/workspace", async (t) => {
  await t.test("issues a long-lived workspace token with a relay_ws_ prefix", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayauth:token:create:*",
          "relayauth:token:read:*",
          "relayauth:role:read:*",
        ],
      },
    });

    const body = await issueWorkspaceToken(app, authHeaders);
    assert.equal(body.workspaceToken.kind, "workspace_token");
    assert.equal(body.workspaceToken.workspaceId, "ws_tokens_route");
    assert.match(body.key, /^relay_ws_[A-Za-z0-9_-]+$/);
    assert.ok(body.key.startsWith(body.workspaceToken.prefix));
  });

  await t.test("rejects scope escalation beyond the caller grant", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*"],
      },
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/workspace", {
      body: {
        workspaceId: "ws_tokens_route",
        name: "too-broad",
        scopes: ["relayauth:token:create:*"],
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 403, (body) => {
      assert.equal(body.error, "insufficient_scope");
    });
  });
});

test("POST /v1/tokens/agent", async (t) => {
  await t.test("exchanges a workspace token for a prefixed agent token pair", async () => {
    const { app, identity, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayauth:token:create:*",
          "relayauth:token:read:*",
          "relayauth:role:read:*",
        ],
      },
      identity: createStoredIdentity({
        id: "agent_runtime_roles",
        orgId: "org_tokens_route",
        workspaceId: "ws_tokens_route",
        scopes: ["relayauth:role:read:*"],
      }),
    });

    const workspaceToken = await issueWorkspaceToken(app, authHeaders);
    const response = await requestRoute(app, "POST", "/v1/tokens/agent", {
      body: {
        agentId: identity.id,
        scopes: ["relayauth:role:read:*"],
        audience: ["relayauth"],
        expiresIn: 7200,
      },
      headers: {
        "x-api-key": workspaceToken.key,
      },
    });

    const body = await assertJsonResponse<AgentTokenPair>(response, 201);
    assert.equal(body.agentId, identity.id);
    assert.equal(body.workspaceId, identity.workspaceId);
    assert.equal(body.tokenClass, "relay_ag");
    assert.match(body.accessToken, /^relay_ag_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(body.refreshToken, /^relay_ag_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    const refreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    assert.equal(accessClaims.meta?.tokenClass, "agent");
    assert.equal(accessClaims.meta?.workspaceTokenId, workspaceToken.workspaceToken.id);
    assert.deepEqual(JSON.parse(accessClaims.meta?.accessScopes ?? "[]"), ["relayauth:role:read:*"]);
    assert.equal(accessClaims.parentTokenId, workspaceToken.workspaceToken.id);
    assert.equal(refreshClaims.meta?.tokenClass, "agent");
    assert.equal(refreshClaims.parentTokenId, workspaceToken.workspaceToken.id);
    assert.ok(accessClaims.exp - accessClaims.iat <= 3600, "agent access TTL should cap at 1h");
  });

  await t.test("rejects bearer auth when a workspace token is required", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const response = await requestRoute(app, "POST", "/v1/tokens/agent", {
      body: {
        agentId: identity.id,
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "workspace_token_required");
    });
  });
});

test("POST /v1/tokens/path", async (t) => {
  await t.test("mints a relay_pa token pair from a workspace token", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayauth:token:create:*",
          "relayfile:fs:read:*",
          "relayfile:fs:write:*",
        ],
      },
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders, {
      scopes: ["relayauth:token:create:*", "relayfile:fs:read:*", "relayfile:fs:write:*"],
    });
    const delegationNotAfter = new Date((Math.floor(Date.now() / 1000) + 30 * 60) * 1000).toISOString();

    const response = await requestRoute(app, "POST", "/v1/tokens/path", {
      body: {
        workspaceId: "ws_tokens_route",
        agentName: "cloud-orchestrator",
        paths: ["/linear/issues/**"],
        ttlSeconds: 7200,
        delegationNotAfter,
      },
      headers: {
        Authorization: `Bearer ${workspaceToken.key}`,
      },
    });

    const body = await assertJsonResponse<PathTokenPair>(response, 201);
    assert.equal(body.agentId, "agent_cloud-orchestrator");
    assert.equal(body.agentName, "cloud-orchestrator");
    assert.equal(body.workspaceId, "ws_tokens_route");
    assert.equal(body.tokenClass, "relay_pa");
    assert.deepEqual(body.paths, ["/linear/issues/*"]);
    assert.equal(body.delegationNotAfter, delegationNotAfter);
    assert.match(body.accessToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(body.refreshToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(Date.parse(body.accessTokenExpiresAt) <= Date.parse(delegationNotAfter));
    assert.ok(Date.parse(body.refreshTokenExpiresAt) <= Date.parse(delegationNotAfter));

    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    const refreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    assert.equal(accessClaims.sub, "agent_cloud-orchestrator");
    assert.equal(accessClaims.meta?.tokenClass, "path");
    assert.equal(accessClaims.meta?.workspaceTokenId, workspaceToken.workspaceToken.id);
    assert.equal(accessClaims.meta?.agentName, "cloud-orchestrator");
    assert.equal(accessClaims.meta?.delegationNotAfter, delegationNotAfter);
    assert.equal(refreshClaims.meta?.delegationNotAfter, delegationNotAfter);
    assert.deepEqual(JSON.parse(accessClaims.meta?.paths ?? "[]"), ["/linear/issues/*"]);
    assert.deepEqual(accessClaims.scopes, [
      "relayfile:fs:read:/linear/issues/*",
      "relayfile:fs:write:/linear/issues/*",
    ]);
    assert.deepEqual(accessClaims.aud, ["relayfile"]);
    assert.ok(accessClaims.exp - accessClaims.iat <= 3600, "path access TTL should cap at 1h");

    const refreshResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: body.refreshToken,
      },
    });
    const refreshed = await assertJsonResponse<TokenPair>(refreshResponse, 200);
    assert.match(refreshed.accessToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(refreshed.refreshToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(Date.parse(refreshed.accessTokenExpiresAt) <= Date.parse(delegationNotAfter));
    assert.ok(Date.parse(refreshed.refreshTokenExpiresAt) <= Date.parse(delegationNotAfter));
    const refreshedClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(refreshed.accessToken, 1);
    assert.equal(refreshedClaims.meta?.tokenClass, "path");
    assert.equal(refreshedClaims.meta?.delegationNotAfter, delegationNotAfter);
    assert.deepEqual(refreshedClaims.scopes, accessClaims.scopes);
  });

  await t.test("rejects path scopes outside the workspace token grant", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayauth:token:create:*", "relayfile:fs:read:*"],
      },
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders, {
      scopes: ["relayauth:token:create:*", "relayfile:fs:read:*"],
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/path", {
      body: {
        agentId: "agent_path_subject",
        paths: ["/linear/issues/**"],
      },
      headers: {
        "x-api-key": workspaceToken.key,
      },
    });

    await assertJsonResponse<ErrorBody>(response, 403, (body) => {
      assert.equal(body.code, "insufficient_scope");
    });
  });
});

test("POST /v1/tokens/workspace-path", async (t) => {
  await t.test("requires workspaceId", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayfile:fs:read:*",
          "relayfile:fs:write:*",
        ],
      },
    });
    const orgApiKey = await issueApiKey(app, authHeaders, [
      "relayauth:api-key:manage:*",
      "relayfile:fs:read:*",
      "relayfile:fs:write:*",
    ]);

    const response = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        paths: ["/github/repos/AgentWorkforce/cloud/issues/123/**"],
        scopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/**"],
      },
      headers: {
        "x-api-key": orgApiKey.key,
      },
    });

    await assertJsonResponse<ErrorBody>(response, 400, (body) => {
      assert.equal(body.code, "workspaceId_required");
    });
  });

  await t.test("mints a short-lived relay_pa directly from an org api key without a seeded workspace row", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayfile:fs:read:*",
          "relayfile:fs:write:*",
        ],
      },
    });
    const orgApiKey = await issueApiKey(app, authHeaders, [
      "relayauth:api-key:manage:*",
      "relayfile:fs:read:*",
      "relayfile:fs:write:*",
    ]);

    const response = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "  ws_tokens_route  ",
        agentName: "cloud-team-member",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/123/**"],
        scopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/**"],
        ttlSeconds: 120,
      },
      headers: {
        "x-api-key": orgApiKey.key,
      },
    });

    const body = await assertJsonResponse<WorkspacePathTokenPair>(response, 201);
    assert.equal(body.agentId, "agent_cloud-team-member");
    assert.equal(body.agentName, "cloud-team-member");
    assert.equal(body.workspaceId, "ws_tokens_route");
    assert.equal(body.tokenClass, "relay_pa");
    assert.deepEqual(body.paths, ["/github/repos/AgentWorkforce/cloud/issues/123/*"]);
    assert.match(body.accessToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(body.refreshToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal("issuedViaWorkspaceTokenId" in body, false);
    assert.equal("workspaceToken" in body, false);
    assert.equal("key" in body, false);

    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    assert.equal(accessClaims.sub, "agent_cloud-team-member");
    assert.equal(accessClaims.wks, "ws_tokens_route");
    assert.equal(accessClaims.org, "org_tokens_route");
    assert.equal(accessClaims.meta?.tokenClass, "path");
    assert.equal(accessClaims.meta?.workspaceTokenId, undefined);
    assert.equal(accessClaims.parentTokenId, undefined);
    assert.deepEqual(JSON.parse(accessClaims.meta?.paths ?? "[]"), ["/github/repos/AgentWorkforce/cloud/issues/123/*"]);
    assert.deepEqual(accessClaims.scopes, [
      "relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*",
    ]);
    assert.deepEqual(accessClaims.aud, ["relayfile"]);
    assert.ok(accessClaims.exp - accessClaims.iat <= 120, "direct path access TTL should honor short ttlSeconds");
  });

  await t.test("stamps the authenticated org even when the workspaceId is associated with another org", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        org: "org_a",
        scopes: [
          "relayauth:api-key:manage:*",
          "relayfile:fs:read:*",
          "relayfile:fs:write:*",
        ],
      },
    });
    await seedWorkspaceContext(app, {
      id: "ws_owned_by_org_b",
      workspaceId: "ws_owned_by_org_b",
      orgId: "org_b",
      scopes: [],
      roles: [],
    });
    const orgApiKey = await issueApiKey(app, authHeaders, [
      "relayauth:api-key:manage:*",
      "relayfile:fs:read:*",
      "relayfile:fs:write:*",
    ]);

    const response = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "ws_owned_by_org_b",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/123/*"],
        scopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
      },
      headers: {
        "x-api-key": orgApiKey.key,
      },
    });

    const body = await assertJsonResponse<WorkspacePathTokenPair>(response, 201);
    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    assert.equal(accessClaims.org, "org_a");
    assert.equal(accessClaims.wks, "ws_owned_by_org_b");
    assert.equal(body.workspaceId, "ws_owned_by_org_b");
  });

  await t.test("caps direct path token TTL at the agent-token maximum", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayfile:fs:read:*",
          "relayfile:fs:write:*",
        ],
      },
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "ws_tokens_route",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/123/*"],
        ttlSeconds: 7200,
      },
      headers: authHeaders,
    });

    const body = await assertJsonResponse<WorkspacePathTokenPair>(response, 201);
    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    assert.ok(accessClaims.exp - accessClaims.iat <= 3600, "direct path access TTL should cap at 1h");
  });

  await t.test("rejects requested scopes outside the org api-key grant", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayfile:fs:read:*"],
      },
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "ws_tokens_route",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/123/*"],
        scopes: ["relayfile:fs:write:/github/repos/AgentWorkforce/cloud/issues/123/*"],
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 403, (body) => {
      assert.equal(body.code, "insufficient_scope");
    });
  });

  await t.test("rejects degenerate or traversal paths", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayfile:fs:write:*"],
      },
    });

    const degenerate = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "ws_tokens_route",
        paths: ["/"],
      },
      headers: authHeaders,
    });
    await assertJsonResponse<ErrorBody>(degenerate, 400, (body) => {
      assert.equal(body.code, "invalid_paths");
    });

    const traversal = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "ws_tokens_route",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/../secrets/*"],
      },
      headers: authHeaders,
    });
    await assertJsonResponse<ErrorBody>(traversal, 400, (body) => {
      assert.equal(body.code, "invalid_paths");
    });
  });
});

test("POST /v1/tokens/refresh", async (t) => {
  await t.test("refreshes a RS256 token pair without requiring a bearer token", async () => {
    const { app, identity } = await createHarness();
    const { pair, accessClaims, refreshClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [accessClaims.jti, refreshClaims.jti]);

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: pair.refreshToken,
      },
    });

    const body = await assertJsonResponse<TokenPair>(response, 200);
    assert.equal(body.tokenType, "Bearer");
    assert.notEqual(body.accessToken, pair.accessToken);
    assert.notEqual(body.refreshToken, pair.refreshToken);

    const nextAccessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);
    const nextRefreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    assertTokenClaimsMatchSpec(nextAccessClaims, {
      tokenType: "access",
      expectedIdentity: identity,
      expectedAudience: ["specialist"],
      expectedScopes: ["specialist:invoke"],
    });
    assertTokenClaimsMatchSpec(nextRefreshClaims, {
      tokenType: "refresh",
      expectedIdentity: identity,
      expectedAudience: ["relayauth"],
      expectedScopes: ["relayauth:token:refresh"],
    });
    assert.notEqual(nextAccessClaims.jti, accessClaims.jti);
    assert.notEqual(nextRefreshClaims.jti, refreshClaims.jti);

    await assertRs256Algorithm(body.accessToken, ["specialist"]);
    await assertRs256Algorithm(body.refreshToken, ["relayauth"]);
  });

  await t.test("returns 400 when refreshToken is missing", async () => {
    const { app } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {},
    });

    await assertJsonResponse<ErrorBody>(response, 400, (body) => {
      assert.match(JSON.stringify(body), /refreshToken/i);
    });
  });

  await t.test("returns 401 when the refresh token is malformed", async () => {
    const { app } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: "definitely-not-a-jwt",
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.match(JSON.stringify(body), /invalid/i);
    });
  });

  await t.test("returns 401 when the refresh token is expired", async () => {
    const { app, identity } = await createHarness();
    const now = Math.floor(Date.now() / 1000) - (2 * 3600);
    const { pair, refreshClaims } = createRs256TokenPair(identity, {
      issuedAt: now,
      accessExpiresInSeconds: 60,
      refreshExpiresInSeconds: 60,
    });
    await seedActiveTokens(app, identity.id, [refreshClaims.jti]);

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: pair.refreshToken,
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.match(JSON.stringify(body), /expired/i);
    });
  });

  await t.test("returns 401 when the refresh token has been revoked", async () => {
    const { app, identity } = await createHarness();
    const { pair, refreshClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [refreshClaims.jti]);

    const revocations = app.storage.revocations as typeof app.storage.revocations & {
      revoke(jti: string, expiresAt: number): Promise<void>;
    };
    await revocations.revoke(refreshClaims.jti, refreshClaims.exp);

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: pair.refreshToken,
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.match(JSON.stringify(body), /revoked/i);
    });
  });

  await t.test("revokes the old refresh JTI after a successful refresh", async () => {
    const { app, identity } = await createHarness();
    const { pair, accessClaims, refreshClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [accessClaims.jti, refreshClaims.jti]);

    assert.deepEqual(await listRevokedTokenIds(app), []);

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: pair.refreshToken },
    });
    await assertJsonResponse<TokenPair>(response, 200);

    const revoked = await listRevokedTokenIds(app);
    assert.ok(
      revoked.includes(refreshClaims.jti),
      `old refresh JTI ${refreshClaims.jti} should be in the revocation list but got ${JSON.stringify(revoked)}`,
    );
  });

  await t.test("detects refresh-token re-use and cascade-revokes the session", async () => {
    const { app, identity } = await createHarness();
    const { pair, accessClaims, refreshClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [accessClaims.jti, refreshClaims.jti]);

    const firstResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: pair.refreshToken },
    });
    const firstBody = await assertJsonResponse<TokenPair>(firstResponse, 200);
    const secondRefreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(firstBody.refreshToken, 1);

    // Replay the original refresh token (single-use violation).
    const replayResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: pair.refreshToken },
    });
    await assertJsonResponse<ErrorBody>(replayResponse, 401, (body) => {
      assert.match(JSON.stringify(body), /revoked/i);
    });

    // The newly issued refresh token should ALSO be unusable now because the
    // session was cascade-revoked.
    const followupResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: firstBody.refreshToken },
    });
    await assertJsonResponse<ErrorBody>(followupResponse, 401);

    const revoked = await listRevokedTokenIds(app);
    assert.ok(revoked.includes(refreshClaims.jti), "original refresh JTI must be revoked");
    assert.ok(
      revoked.includes(secondRefreshClaims.jti),
      `second refresh JTI ${secondRefreshClaims.jti} must be revoked after re-use detection (got ${JSON.stringify(revoked)})`,
    );
  });

  await t.test("rejects a refresh token signed with the wrong issuer", async () => {
    const { app, identity } = await createHarness();
    const now = Math.floor(Date.now() / 1000);
    const sid = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    const jti = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    await seedActiveTokens(app, identity.id, [jti]);

    const evilRefresh = signRs256Jwt({
      sub: identity.id,
      org: identity.orgId,
      wks: identity.workspaceId,
      scopes: ["relayauth:token:refresh"],
      sponsorId: identity.sponsorId,
      sponsorChain: [...identity.sponsorChain],
      token_type: "refresh",
      iss: "https://evil.example",
      aud: ["relayauth"],
      exp: now + 3600,
      iat: now,
      jti,
      sid,
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: evilRefresh },
    });
    await assertJsonResponse<ErrorBody>(response, 401);
  });

  await t.test("rejects a refresh token with a non-relayauth audience", async () => {
    const { app, identity } = await createHarness();
    const now = Math.floor(Date.now() / 1000);
    const sid = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    const jti = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    await seedActiveTokens(app, identity.id, [jti]);

    const wrongAudRefresh = signRs256Jwt({
      sub: identity.id,
      org: identity.orgId,
      wks: identity.workspaceId,
      scopes: ["relayauth:token:refresh"],
      sponsorId: identity.sponsorId,
      sponsorChain: [...identity.sponsorChain],
      token_type: "refresh",
      iss: "https://relayauth.dev",
      aud: ["not-relayauth"],
      exp: now + 3600,
      iat: now,
      jti,
      sid,
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: wrongAudRefresh },
    });
    await assertJsonResponse<ErrorBody>(response, 401);
  });

  await t.test("rejects a refresh token whose exp is beyond clock-skew in the past", async () => {
    const { app, identity } = await createHarness();
    const past = Math.floor(Date.now() / 1000) - 1000;
    const expiredRefresh = signRs256Jwt({
      sub: identity.id,
      org: identity.orgId,
      wks: identity.workspaceId,
      scopes: ["relayauth:token:refresh"],
      sponsorId: identity.sponsorId,
      sponsorChain: [...identity.sponsorChain],
      token_type: "refresh",
      iss: "https://relayauth.dev",
      aud: ["relayauth"],
      exp: past + 60, // exp 120s before "now"
      iat: past,
      jti: `tok_${crypto.randomUUID().replace(/-/g, "")}`,
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: expiredRefresh },
    });
    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.match(JSON.stringify(body), /expired|invalid/i);
    });
  });

  await t.test("accepts a refresh token whose exp is within the 60s clock-skew allowance", async () => {
    const { app, identity } = await createHarness();
    const now = Math.floor(Date.now() / 1000);
    const jti = `tok_${crypto.randomUUID().replace(/-/g, "")}`;
    const sid = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    await seedActiveTokens(app, identity.id, [jti]);

    const skewedRefresh = signRs256Jwt({
      sub: identity.id,
      org: identity.orgId,
      wks: identity.workspaceId,
      scopes: ["relayauth:token:refresh"],
      sponsorId: identity.sponsorId,
      sponsorChain: [...identity.sponsorChain],
      token_type: "refresh",
      iss: "https://relayauth.dev",
      aud: ["relayauth"],
      exp: now - 20, // 20s past exp, should be accepted within verifier and route skew
      iat: now - 120,
      jti,
      sid,
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: skewedRefresh },
    });
    await assertJsonResponse<TokenPair>(response, 200);
  });

  await t.test("rejects path token refresh at the delegation horizon without persisting a new pair", async () => {
    const { app } = await createHarness();
    const now = Math.floor(Date.now() / 1000);
    const jti = `relay_pa_${crypto.randomUUID().replace(/-/g, "")}`;
    const sid = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    const refreshToken = signRs256Jwt({
      sub: "agent_path_horizon",
      org: "org_tokens_route",
      wks: "ws_tokens_route",
      scopes: ["relayauth:token:refresh"],
      sponsorId: "user_tokens_owner",
      sponsorChain: ["user_tokens_owner", "agent_path_horizon"],
      token_type: "refresh",
      iss: "https://relayauth.dev",
      aud: ["relayauth"],
      exp: now + 3600,
      iat: now - 60,
      jti,
      sid,
      meta: {
        tokenClass: "path",
        agentName: "path-horizon",
        paths: JSON.stringify(["/linear/issues/*"]),
        accessScopes: JSON.stringify(["relayfile:fs:read:/linear/issues/*"]),
        accessAudience: JSON.stringify(["relayfile"]),
        delegationNotAfter: new Date((now - 10) * 1000).toISOString(),
      },
    });
    await seedActiveTokens(app, "agent_path_horizon", [jti]);
    const beforeCount = await countStoredTokens(app);

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "delegation_expired");
    });
    assert.equal(await countStoredTokens(app), beforeCount);
  });

  await t.test("workspace token revocation wins over an expired delegation horizon", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayauth:token:create:*", "relayfile:fs:read:*"],
      },
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders, {
      scopes: ["relayauth:token:create:*", "relayfile:fs:read:*"],
    });
    const revokeResponse = await requestRoute(
      app,
      "POST",
      `/v1/api-keys/${workspaceToken.workspaceToken.id}/revoke`,
      { body: {}, headers: authHeaders },
    );
    assert.equal(revokeResponse.status, 200);

    const now = Math.floor(Date.now() / 1000);
    const jti = `relay_pa_${crypto.randomUUID().replace(/-/g, "")}`;
    const refreshToken = signRs256Jwt({
      sub: "agent_path_revoked_horizon",
      org: "org_tokens_route",
      wks: "ws_tokens_route",
      scopes: ["relayauth:token:refresh"],
      sponsorId: "user_tokens_owner",
      sponsorChain: ["user_tokens_owner", "agent_path_revoked_horizon"],
      token_type: "refresh",
      iss: "https://relayauth.dev",
      aud: ["relayauth"],
      exp: now + 3600,
      iat: now - 60,
      jti,
      sid: `sess_${crypto.randomUUID().replace(/-/g, "")}`,
      parentTokenId: workspaceToken.workspaceToken.id,
      meta: {
        tokenClass: "path",
        workspaceTokenId: workspaceToken.workspaceToken.id,
        agentName: "path-revoked-horizon",
        paths: JSON.stringify(["/linear/issues/*"]),
        accessScopes: JSON.stringify(["relayfile:fs:read:/linear/issues/*"]),
        accessAudience: JSON.stringify(["relayfile"]),
        delegationNotAfter: new Date((now - 10) * 1000).toISOString(),
      },
    });
    await seedActiveTokens(app, "agent_path_revoked_horizon", [jti]);

    const response = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "workspace_token_revoked");
    });
  });

  await t.test("preserves prefixed agent token shape and narrowed scopes on refresh", async () => {
    const { app, identity, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayauth:token:create:*", "relayauth:role:read:*"],
      },
      identity: createStoredIdentity({
        id: "agent_runtime_refresh",
        orgId: "org_tokens_route",
        workspaceId: "ws_tokens_route",
        scopes: ["relayauth:role:read:*"],
      }),
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders);
    const issueResponse = await requestRoute(app, "POST", "/v1/tokens/agent", {
      body: {
        agentId: identity.id,
        scopes: ["relayauth:role:read:*"],
      },
      headers: {
        "x-api-key": workspaceToken.key,
      },
    });
    const issued = await assertJsonResponse<AgentTokenPair>(issueResponse, 201);

    const refreshResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: issued.refreshToken,
      },
    });
    const refreshed = await assertJsonResponse<TokenPair>(refreshResponse, 200);

    assert.match(refreshed.accessToken, /^relay_ag_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(refreshed.refreshToken, /^relay_ag_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const refreshedAccessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(refreshed.accessToken, 1);
    assert.equal(refreshedAccessClaims.meta?.tokenClass, "agent");
    assert.deepEqual(JSON.parse(refreshedAccessClaims.meta?.accessScopes ?? "[]"), ["relayauth:role:read:*"]);
  });

  await t.test("rejects refreshing an agent token after its workspace token is revoked", async () => {
    const { app, identity, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayauth:token:create:*", "relayauth:role:read:*"],
      },
      identity: createStoredIdentity({
        id: "agent_runtime_revoked_refresh",
        orgId: "org_tokens_route",
        workspaceId: "ws_tokens_route",
        scopes: ["relayauth:role:read:*"],
      }),
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders);
    const issueResponse = await requestRoute(app, "POST", "/v1/tokens/agent", {
      body: {
        agentId: identity.id,
        scopes: ["relayauth:role:read:*"],
      },
      headers: {
        "x-api-key": workspaceToken.key,
      },
    });
    const issued = await assertJsonResponse<AgentTokenPair>(issueResponse, 201);

    const revokeResponse = await requestRoute(
      app,
      "POST",
      `/v1/api-keys/${workspaceToken.workspaceToken.id}/revoke`,
      {
        body: {},
        headers: authHeaders,
      },
    );
    assert.equal(revokeResponse.status, 200);

    const refreshResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: {
        refreshToken: issued.refreshToken,
      },
    });
    await assertJsonResponse<ErrorBody>(refreshResponse, 401, (body) => {
      assert.equal(body.code, "workspace_token_revoked");
    });
  });
});

test("POST /v1/tokens enforces max sponsor-chain depth", async (t) => {
  await t.test("rejects issuance when identity.sponsorChain exceeds 10", async () => {
    const deepChain = Array.from({ length: 11 }, (_, index) =>
      index === 10 ? "agent_deep_subject" : `user_ancestor_${index}`,
    );
    const deepIdentity = createStoredIdentity({
      id: "agent_deep_subject",
      name: "Deep Subject",
      orgId: "org_tokens_route",
      workspaceId: "ws_tokens_route",
      sponsorId: "user_ancestor_0",
      sponsorChain: deepChain,
      scopes: ["specialist:invoke"],
    });

    const { app, authHeaders } = await createHarness({ identity: deepIdentity });

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: deepIdentity.id,
        scopes: ["specialist:invoke"],
        audience: ["specialist"],
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 400, (body) => {
      assert.match(JSON.stringify(body), /delegation|depth|chain/i);
    });
  });
});

test("POST /v1/tokens/revoke", async (t) => {
  await t.test("revokes a token id and persists the revocation", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const { accessClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [accessClaims.jti]);

    const response = await requestRoute(app, "POST", "/v1/tokens/revoke", {
      body: {
        tokenId: accessClaims.jti,
      },
      headers: authHeaders,
    });

    assert.equal(response.status, 204);
    assert.deepEqual(await listRevokedTokenIds(app), [accessClaims.jti]);
  });

  await t.test("returns 401 when Authorization is missing", async () => {
    const { app } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens/revoke", {
      body: {
        tokenId: "tok_missing_auth",
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "missing_authorization");
    });
  });

  await t.test("returns 403 when the caller lacks relayauth:token:manage scope", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:identity:read:*"],
      },
    });

    const response = await requestRoute(app, "POST", "/v1/tokens/revoke", {
      body: {
        tokenId: "tok_forbidden_revoke",
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 403, (body) => {
      assert.match(JSON.stringify(body), /scope/i);
    });
  });

  await t.test("returns 400 when tokenId, identityId, and sessionId are all missing", async () => {
    const { app, authHeaders } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens/revoke", {
      body: {},
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 400, (body) => {
      assert.match(JSON.stringify(body), /tokenId|identityId|sessionId/i);
    });
  });

  await t.test("returns 404 when the target token does not exist", async () => {
    const { app, authHeaders } = await createHarness();

    const response = await requestRoute(app, "POST", "/v1/tokens/revoke", {
      body: {
        tokenId: "tok_missing_revoke_target",
      },
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 404, (body) => {
      assert.match(JSON.stringify(body), /not[_ -]?found|missing/i);
    });
  });
});

test("GET /v1/tokens/introspect", async (t) => {
  await t.test("returns raw claims for an active access token", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const { pair, accessClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [accessClaims.jti]);

    const response = await requestRoute(
      app,
      "GET",
      `/v1/tokens/introspect?token=${encodeURIComponent(pair.accessToken)}`,
      {
        headers: authHeaders,
      },
    );

    const body = await assertJsonResponse<RelayAuthTokenClaims>(response, 200);
    assert.deepEqual(body, accessClaims);
    assertTokenClaimsMatchSpec(body, {
      tokenType: "access",
      expectedIdentity: identity,
      expectedAudience: ["specialist"],
      expectedScopes: ["specialist:invoke"],
    });
  });

  await t.test("returns 401 when Authorization is missing", async () => {
    const { app } = await createHarness();

    const response = await requestRoute(app, "GET", "/v1/tokens/introspect?token=abc");

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.code, "missing_authorization");
    });
  });

  await t.test("returns 400 when the token query parameter is missing", async () => {
    const { app, authHeaders } = await createHarness();

    const response = await requestRoute(app, "GET", "/v1/tokens/introspect", {
      headers: authHeaders,
    });

    await assertJsonResponse<ErrorBody>(response, 400, (body) => {
      assert.match(JSON.stringify(body), /token/i);
    });
  });

  await t.test("returns null for an expired access token", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const now = Math.floor(Date.now() / 1000) - (2 * 3600);
    const { pair, accessClaims } = createRs256TokenPair(identity, {
      issuedAt: now,
      accessExpiresInSeconds: 60,
    });
    await seedActiveTokens(app, identity.id, [accessClaims.jti]);

    const response = await requestRoute(
      app,
      "GET",
      `/v1/tokens/introspect?token=${encodeURIComponent(pair.accessToken)}`,
      {
        headers: authHeaders,
      },
    );

    const body = await assertJsonResponse<RelayAuthTokenClaims | null>(response, 200);
    assert.equal(body, null);
  });

  await t.test("returns null for a revoked access token", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const { pair, accessClaims } = createRs256TokenPair(identity);
    await seedActiveTokens(app, identity.id, [accessClaims.jti]);

    const revocations = app.storage.revocations as typeof app.storage.revocations & {
      revoke(jti: string, expiresAt: number): Promise<void>;
    };
    await revocations.revoke(accessClaims.jti, accessClaims.exp);

    const response = await requestRoute(
      app,
      "GET",
      `/v1/tokens/introspect?token=${encodeURIComponent(pair.accessToken)}`,
      {
        headers: authHeaders,
      },
    );

    const body = await assertJsonResponse<RelayAuthTokenClaims | null>(response, 200);
    assert.equal(body, null);
  });

  await t.test("returns null for an agent token after its workspace token is revoked", async () => {
    const { app, identity, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayauth:token:create:*",
          "relayauth:token:read:*",
          "relayauth:role:read:*",
        ],
      },
      identity: createStoredIdentity({
        id: "agent_runtime_introspect_after_revoke",
        orgId: "org_tokens_route",
        workspaceId: "ws_tokens_route",
        scopes: ["relayauth:role:read:*"],
      }),
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders);
    const issueResponse = await requestRoute(app, "POST", "/v1/tokens/agent", {
      body: {
        agentId: identity.id,
        scopes: ["relayauth:role:read:*"],
      },
      headers: {
        "x-api-key": workspaceToken.key,
      },
    });
    const issued = await assertJsonResponse<AgentTokenPair>(issueResponse, 201);

    const revokeResponse = await requestRoute(
      app,
      "POST",
      `/v1/api-keys/${workspaceToken.workspaceToken.id}/revoke`,
      {
        body: {},
        headers: authHeaders,
      },
    );
    assert.equal(revokeResponse.status, 200);

    const response = await requestRoute(
      app,
      "GET",
      `/v1/tokens/introspect?token=${encodeURIComponent(issued.accessToken)}`,
      {
        headers: authHeaders,
      },
    );

    const body = await assertJsonResponse<RelayAuthTokenClaims | null>(response, 200);
    assert.equal(body, null);
  });
});

test("derived agent bearer auth", async (t) => {
  await t.test("closes derived agent tokens after workspace-token revocation", async () => {
    const { app, identity, authHeaders } = await createHarness({
      authClaims: {
        scopes: ["relayauth:api-key:manage:*", "relayauth:token:create:*", "relayauth:role:read:*"],
      },
      identity: createStoredIdentity({
        id: "agent_runtime_roles_after_revoke",
        orgId: "org_tokens_route",
        workspaceId: "ws_tokens_route",
        scopes: ["relayauth:role:read:*"],
      }),
    });
    const workspaceToken = await issueWorkspaceToken(app, authHeaders);
    const issueResponse = await requestRoute(app, "POST", "/v1/tokens/agent", {
      body: {
        agentId: identity.id,
        scopes: ["relayauth:role:read:*"],
      },
      headers: {
        "x-api-key": workspaceToken.key,
      },
    });
    const issued = await assertJsonResponse<AgentTokenPair>(issueResponse, 201);

    const beforeRevoke = await requestRoute(app, "GET", "/v1/roles", {
      headers: {
        Authorization: `Bearer ${issued.accessToken}`,
      },
    });
    assert.equal(beforeRevoke.status, 200);

    const revokeResponse = await requestRoute(
      app,
      "POST",
      `/v1/api-keys/${workspaceToken.workspaceToken.id}/revoke`,
      {
        body: {},
        headers: authHeaders,
      },
    );
    assert.equal(revokeResponse.status, 200);

    const afterRevoke = await requestRoute(app, "GET", "/v1/roles", {
      headers: {
        Authorization: `Bearer ${issued.accessToken}`,
      },
    });
    await assertJsonResponse<ErrorBody>(afterRevoke, 401, (body) => {
      assert.equal(body.code, "workspace_token_revoked");
    });
  });
});

test("POST /v1/tokens refreshTokenTtlSeconds", async (t) => {
  await t.test("issues a refresh token with the requested TTL when refreshTokenTtlSeconds is provided", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const THIRTY_DAYS = 30 * 24 * 3600;

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: identity.id,
        scopes: ["specialist:invoke"],
        audience: ["specialist"],
        refreshTokenTtlSeconds: THIRTY_DAYS,
      },
      headers: authHeaders,
    });

    const body = await assertJsonResponse<TokenPair>(response, 201);
    const refreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    const accessClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.accessToken, 1);

    const refreshTtl = refreshClaims.exp - refreshClaims.iat;
    assert.ok(refreshTtl >= THIRTY_DAYS - 5, `expected refresh TTL ~${THIRTY_DAYS}s, got ${refreshTtl}`);
    assert.ok(refreshTtl <= THIRTY_DAYS + 5, `expected refresh TTL ~${THIRTY_DAYS}s, got ${refreshTtl}`);

    assert.equal(refreshClaims.meta?.refreshTokenTtl, String(THIRTY_DAYS));
    assert.equal(accessClaims.meta?.refreshTokenTtl, String(THIRTY_DAYS));
  });

  await t.test("caps refreshTokenTtlSeconds at 90 days (MAX_OPERATOR_REFRESH_TOKEN_TTL_SECONDS)", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const NINETY_DAYS = 90 * 24 * 3600;
    const TOO_LARGE = 365 * 24 * 3600;

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: identity.id,
        scopes: ["specialist:invoke"],
        refreshTokenTtlSeconds: TOO_LARGE,
      },
      headers: authHeaders,
    });

    const body = await assertJsonResponse<TokenPair>(response, 201);
    const refreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    const refreshTtl = refreshClaims.exp - refreshClaims.iat;
    assert.ok(refreshTtl <= NINETY_DAYS + 5, `refresh TTL must be capped at 90d, got ${refreshTtl}`);
    assert.equal(refreshClaims.meta?.refreshTokenTtl, String(NINETY_DAYS));
  });

  await t.test("defaults to 24h refresh TTL when refreshTokenTtlSeconds is absent", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const DEFAULT_24H = 24 * 3600;

    const response = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: identity.id,
        scopes: ["specialist:invoke"],
      },
      headers: authHeaders,
    });

    const body = await assertJsonResponse<TokenPair>(response, 201);
    const refreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(body.refreshToken, 1);
    const refreshTtl = refreshClaims.exp - refreshClaims.iat;
    assert.ok(refreshTtl >= DEFAULT_24H - 5, `expected default 24h refresh TTL, got ${refreshTtl}`);
    assert.ok(refreshTtl <= DEFAULT_24H + 5, `expected default 24h refresh TTL, got ${refreshTtl}`);
    assert.equal(refreshClaims.meta?.refreshTokenTtl, undefined);
  });

  await t.test("propagates refreshTokenTtl through rotation so each new refresh token gets the same TTL", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const THIRTY_DAYS = 30 * 24 * 3600;

    const issueResponse = await requestRoute(app, "POST", "/v1/tokens", {
      body: {
        identityId: identity.id,
        scopes: ["specialist:invoke"],
        refreshTokenTtlSeconds: THIRTY_DAYS,
      },
      headers: authHeaders,
    });
    const issued = await assertJsonResponse<TokenPair>(issueResponse, 201);

    const refreshResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: issued.refreshToken },
    });
    const rotated = await assertJsonResponse<TokenPair>(refreshResponse, 200);

    const rotatedRefreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(rotated.refreshToken, 1);
    const rotatedRefreshTtl = rotatedRefreshClaims.exp - rotatedRefreshClaims.iat;
    assert.ok(
      rotatedRefreshTtl >= THIRTY_DAYS - 5,
      `expected rotated refresh TTL ~${THIRTY_DAYS}s, got ${rotatedRefreshTtl}`,
    );
    assert.ok(
      rotatedRefreshTtl <= THIRTY_DAYS + 5,
      `expected rotated refresh TTL ~${THIRTY_DAYS}s, got ${rotatedRefreshTtl}`,
    );
    assert.equal(rotatedRefreshClaims.meta?.refreshTokenTtl, String(THIRTY_DAYS));
  });

  await t.test("workspace-path mint: 90d TTL lands in token meta and survives /v1/tokens/refresh", async () => {
    const { app, authHeaders } = await createHarness({
      authClaims: {
        scopes: [
          "relayauth:api-key:manage:*",
          "relayfile:fs:read:*",
          "relayfile:fs:write:*",
        ],
      },
    });
    const orgApiKey = await issueApiKey(app, authHeaders, [
      "relayauth:api-key:manage:*",
      "relayfile:fs:read:*",
      "relayfile:fs:write:*",
    ]);
    const NINETY_DAYS = 90 * 24 * 3600;

    const mintResponse = await requestRoute(app, "POST", "/v1/tokens/workspace-path", {
      body: {
        workspaceId: "ws_tokens_route",
        agentName: "cloud-orchestrator",
        paths: ["/github/repos/*"],
        scopes: ["relayfile:fs:read:/github/repos/*"],
        refreshTokenTtlSeconds: NINETY_DAYS,
      },
      headers: { "x-api-key": orgApiKey.key },
    });

    const minted = await assertJsonResponse<WorkspacePathTokenPair>(mintResponse, 201);
    const mintedRefreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(minted.refreshToken, 1);

    const mintedRefreshTtl = mintedRefreshClaims.exp - mintedRefreshClaims.iat;
    assert.ok(mintedRefreshTtl >= NINETY_DAYS - 5, `minted refresh TTL should be ~90d, got ${mintedRefreshTtl}`);
    assert.ok(mintedRefreshTtl <= NINETY_DAYS + 5, `minted refresh TTL should be ~90d, got ${mintedRefreshTtl}`);
    assert.equal(mintedRefreshClaims.meta?.refreshTokenTtl, String(NINETY_DAYS));

    const refreshResponse = await requestRoute(app, "POST", "/v1/tokens/refresh", {
      body: { refreshToken: minted.refreshToken },
    });
    const rotated = await assertJsonResponse<TokenPair>(refreshResponse, 200);

    const rotatedRefreshClaims = decodeJwtJsonSegment<RelayAuthTokenClaims>(rotated.refreshToken, 1);
    const rotatedRefreshTtl = rotatedRefreshClaims.exp - rotatedRefreshClaims.iat;
    assert.ok(rotatedRefreshTtl >= NINETY_DAYS - 5, `rotated refresh TTL should be ~90d, got ${rotatedRefreshTtl}`);
    assert.ok(rotatedRefreshTtl <= NINETY_DAYS + 5, `rotated refresh TTL should be ~90d, got ${rotatedRefreshTtl}`);
    assert.equal(rotatedRefreshClaims.meta?.refreshTokenTtl, String(NINETY_DAYS));
    assert.match(rotated.accessToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(rotated.refreshToken, /^relay_pa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
