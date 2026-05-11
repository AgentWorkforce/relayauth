import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { RelayAuthTokenClaims } from "@relayauth/types";
import { RelayAuthClient } from "@relayauth/sdk";

const TEST_RS256_PRIVATE_KEY_PEM = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signRs256Jwt(claims: RelayAuthTokenClaims): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), TEST_RS256_PRIVATE_KEY_PEM)
    .toString("base64url");

  return `${unsigned}.${signature}`;
}

function decodeClaims(token: string): RelayAuthTokenClaims {
  const [, payload] = token.split(".");
  assert.ok(payload, "expected compact JWT payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RelayAuthTokenClaims;
}

test("issueToken uses a 1h access expiry and refreshToken rotates the pair", async (t) => {
  const originalFetch = globalThis.fetch;
  const issuedAt = Math.floor(Date.now() / 1000);
  const identityId = "agent_runtime_worker";
  const accessClaims: RelayAuthTokenClaims = {
    sub: identityId,
    org: "org_runtime_test",
    wks: "ws_runtime_test",
    scopes: ["specialist:invoke"],
    sponsorId: "user_runtime_owner",
    sponsorChain: ["user_runtime_owner", identityId],
    token_type: "access",
    iss: "https://relayauth.dev",
    aud: ["specialist"],
    exp: issuedAt + 3600,
    iat: issuedAt,
    jti: "tok_initial_access",
  };
  const refreshClaims: RelayAuthTokenClaims = {
    sub: identityId,
    org: "org_runtime_test",
    wks: "ws_runtime_test",
    scopes: ["relayauth:token:refresh"],
    sponsorId: "user_runtime_owner",
    sponsorChain: ["user_runtime_owner", identityId],
    token_type: "refresh",
    iss: "https://relayauth.dev",
    aud: ["relayauth"],
    exp: issuedAt + 24 * 3600,
    iat: issuedAt,
    jti: "tok_initial_refresh",
  };
  const rotatedAt = issuedAt + 5;
  const rotatedAccessClaims: RelayAuthTokenClaims = {
    ...accessClaims,
    exp: rotatedAt + 3600,
    iat: rotatedAt,
    jti: "tok_rotated_access",
  };
  const rotatedRefreshClaims: RelayAuthTokenClaims = {
    ...refreshClaims,
    exp: rotatedAt + 24 * 3600,
    iat: rotatedAt,
    jti: "tok_rotated_refresh",
  };

  const issuedPair = {
    accessToken: signRs256Jwt(accessClaims),
    refreshToken: signRs256Jwt(refreshClaims),
    accessTokenExpiresAt: new Date(accessClaims.exp * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(refreshClaims.exp * 1000).toISOString(),
    tokenType: "Bearer",
  };
  const rotatedPair = {
    accessToken: signRs256Jwt(rotatedAccessClaims),
    refreshToken: signRs256Jwt(rotatedRefreshClaims),
    accessTokenExpiresAt: new Date(rotatedAccessClaims.exp * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(rotatedRefreshClaims.exp * 1000).toISOString(),
    tokenType: "Bearer",
  };

  let refreshCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);

    if (url.pathname === "/v1/tokens" && request.method === "POST") {
      const body = (await request.json()) as {
        identityId: string;
        scopes: string[];
        audience: string[];
        expiresIn: number;
      };
      assert.equal(body.identityId, identityId);
      assert.deepEqual(body.scopes, ["specialist:invoke"]);
      assert.deepEqual(body.audience, ["specialist"]);
      assert.equal(body.expiresIn, 3600);
      return Response.json(issuedPair, { status: 201 });
    }

    if (url.pathname === "/v1/tokens/refresh" && request.method === "POST") {
      const body = (await request.json()) as { refreshToken: string };
      refreshCount += 1;
      if (refreshCount === 1) {
        assert.equal(body.refreshToken, issuedPair.refreshToken);
        return Response.json(rotatedPair, { status: 200 });
      }
      assert.equal(body.refreshToken, issuedPair.refreshToken);
      return Response.json({ error: "token_revoked" }, { status: 401 });
    }

    return Response.json({ error: "unexpected_request" }, { status: 500 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RelayAuthClient({
    baseUrl: "https://relayauth.dev",
    token: "relay_ws_test",
  });

  const issued = await client.issueToken(identityId, {
    scopes: ["specialist:invoke"],
    audience: ["specialist"],
    expiresIn: 3600,
  });

  const issuedAccessClaims = decodeClaims(issued.accessToken);
  const issuedRefreshClaims = decodeClaims(issued.refreshToken);

  assert.equal(issuedAccessClaims.sub, identityId);
  assert.deepEqual(issuedAccessClaims.scopes, ["specialist:invoke"]);
  assert.deepEqual(issuedAccessClaims.aud, ["specialist"]);
  assert.equal(issuedAccessClaims.exp - issuedAccessClaims.iat, 3600);
  assert.equal(issuedRefreshClaims.token_type, "refresh");
  assert.deepEqual(issuedRefreshClaims.aud, ["relayauth"]);

  const refreshed = await client.refreshToken(issued.refreshToken);
  const refreshedAccessClaims = decodeClaims(refreshed.accessToken);
  const refreshedRefreshClaims = decodeClaims(refreshed.refreshToken);

  assert.notEqual(refreshed.accessToken, issued.accessToken);
  assert.notEqual(refreshed.refreshToken, issued.refreshToken);
  assert.notEqual(refreshedAccessClaims.jti, issuedAccessClaims.jti);
  assert.notEqual(refreshedRefreshClaims.jti, issuedRefreshClaims.jti);
  assert.equal(refreshedAccessClaims.sub, identityId);
  assert.equal(refreshedAccessClaims.exp - refreshedAccessClaims.iat, 3600);

  await assert.rejects(
    client.refreshToken(issued.refreshToken),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /revoked/i);
      return true;
    },
  );
});
