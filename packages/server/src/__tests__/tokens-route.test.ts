import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { RelayAuthTokenClaims, TokenPair } from "@relayauth/types";

import { RelayAuthError } from "../../../sdk/typescript/src/errors.js";
import { TokenVerifier } from "../../../sdk/typescript/src/verify.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  listRevokedTokenIds,
  seedActiveTokens,
  seedStoredIdentity,
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

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signLegacyHs256Jwt(
  claims: RelayAuthTokenClaims,
  {
    secret = "dev-secret",
    keyId = "dev-key",
  }: {
    secret?: string;
    keyId?: string;
  } = {},
): string {
  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: keyId,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");

  return `${unsigned}.${signature}`;
}

function decodeJwtJsonSegment<T>(token: string, index: 0 | 1): T {
  const segments = token.split(".");
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

  return signLegacyHs256Jwt({
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

function createLegacyPhase0TokenPair(
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
      accessToken: signLegacyHs256Jwt(accessClaims),
      refreshToken: signLegacyHs256Jwt(refreshClaims),
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
  assert.equal("workspace_id" in claims, false, "legacy workspace_id alias should not be present");
  assert.equal("agent_name" in claims, false, "legacy agent_name alias should not be present");
  assert.equal("sponsor" in claims, false, "legacy sponsor claim should not be present");

  if (tokenType === "refresh") {
    assert.deepEqual(claims.aud, ["relayauth"]);
  }
}

async function assertPhase0LegacyHs256Algorithm(token: string, audience: string[]): Promise<void> {
  const header = decodeJwtJsonSegment<JwtHeader>(token, 0);
  assert.deepEqual(header, {
    alg: "HS256",
    typ: "JWT",
    kid: "dev-key",
  });

  const verifier = new TokenVerifier({
    jwksUrl: "https://relayauth.test/.well-known/jwks.json",
    issuer: "https://relayauth.dev",
    audience,
  });

  await assert.rejects(
    () => verifier.verify(token),
    (error: unknown) => {
      assert.ok(error instanceof RelayAuthError);
      assert.equal(error.code, "invalid_token");
      return true;
    },
    "spec-compliant verifiers should reject legacy HS256 tokens until RS256 lands",
  );
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

test("POST /v1/tokens", async (t) => {
  await t.test("issues a Phase 0 legacy HS256 token pair with token-format claim shape", async () => {
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

    await assertPhase0LegacyHs256Algorithm(body.accessToken, ["specialist"]);
    await assertPhase0LegacyHs256Algorithm(body.refreshToken, ["relayauth"]);
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

test("POST /v1/tokens/refresh", async (t) => {
  await t.test("refreshes a legacy HS256 token pair without requiring a bearer token", async () => {
    const { app, identity } = await createHarness();
    const { pair, accessClaims, refreshClaims } = createLegacyPhase0TokenPair(identity);
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

    await assertPhase0LegacyHs256Algorithm(body.accessToken, ["specialist"]);
    await assertPhase0LegacyHs256Algorithm(body.refreshToken, ["relayauth"]);
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
    const { pair, refreshClaims } = createLegacyPhase0TokenPair(identity, {
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
    const { pair, refreshClaims } = createLegacyPhase0TokenPair(identity);
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
});

test("POST /v1/tokens/revoke", async (t) => {
  await t.test("revokes a token id and persists the revocation", async () => {
    const { app, identity, authHeaders } = await createHarness();
    const { accessClaims } = createLegacyPhase0TokenPair(identity);
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
    const { pair, accessClaims } = createLegacyPhase0TokenPair(identity);
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
    const { pair, accessClaims } = createLegacyPhase0TokenPair(identity, {
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
    const { pair, accessClaims } = createLegacyPhase0TokenPair(identity);
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
});
