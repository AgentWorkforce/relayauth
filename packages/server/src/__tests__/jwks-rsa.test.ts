import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { signToken } from "../lib/sign.js";
import { createApp } from "../server.js";
import type { AppEnv } from "../env.js";
import { assertJsonResponse, createTestRequest, createTestStorage } from "./test-helpers.js";

type ExtendedBindings = AppEnv["Bindings"] & Record<string, string | undefined>;

function createBindings(overrides: Partial<ExtendedBindings> = {}): ExtendedBindings {
  return {
    INTERNAL_SECRET: "internal-test-secret",
    ...overrides,
  };
}

function createRequestBindings(
  overrides: Partial<ExtendedBindings> = {},
): AppEnv["Bindings"] {
  return createBindings(overrides) as AppEnv["Bindings"];
}

function createPublicKeyPem(): string {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  return publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
}

async function requestJwks(overrides: Partial<ExtendedBindings> = {}) {
  const storage = createTestStorage();
  const app = createApp({ storage });

  try {
    return await app.request(
      createTestRequest("GET", "/.well-known/jwks.json"),
      undefined,
      createRequestBindings(overrides),
    );
  } finally {
    await storage.close();
  }
}

test("JWKS publishes an RSA public JWK when RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is set and never exposes private material", async () => {
  const response = await requestJwks({
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: createPublicKeyPem(),
  });
  const body = await assertJsonResponse<{ keys: JsonWebKey[] }>(response, 200);
  const rsaKey = body.keys.find((key) => key.kty === "RSA");

  assert.ok(rsaKey, "expected an RSA JWK in the JWKS response");
  assert.equal(rsaKey.use, "sig");
  assert.equal(rsaKey.alg, "RS256");
  assert.equal(typeof rsaKey.kid, "string");
  assert.ok((rsaKey.kid ?? "").length > 0, "expected RSA JWK to include a kid");
  assert.equal(typeof rsaKey.n, "string");
  assert.ok((rsaKey.n ?? "").length > 0, "expected RSA JWK to include modulus n");
  assert.equal(typeof rsaKey.e, "string");
  assert.ok((rsaKey.e ?? "").length > 0, "expected RSA JWK to include exponent e");
  assert.equal("d" in rsaKey, false, "JWKS must never expose the private exponent");
});

test("JWKS returns an empty key set when RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is unset", async () => {
  const response = await requestJwks();
  const body = await assertJsonResponse<{ keys: JsonWebKey[] }>(response, 200);

  assert.deepEqual(body.keys, []);
});

test("JWKS never advertises HS256 metadata", async () => {
  const response = await requestJwks({
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: createPublicKeyPem(),
  });
  const body = await assertJsonResponse<{ keys: JsonWebKey[] }>(response, 200);

  assert.equal(body.keys.some((key) => key.alg === "HS256" || key.kty === "oct"), false);
  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0]?.alg, "RS256");
});

test("JWKS RSA `kid` is the RFC 7638 JWK thumbprint (deterministic, no YYYY-MM component)", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const response = await requestJwks({ RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: publicKeyPem });
  const body = await assertJsonResponse<{ keys: JsonWebKey[] }>(response, 200);
  const rsaKey = body.keys.find((key) => key.kty === "RSA");

  assert.ok(rsaKey, "expected an RSA JWK in the JWKS response");
  assert.equal(typeof rsaKey.n, "string");
  assert.equal(typeof rsaKey.e, "string");

  const canonical = `{"e":"${rsaKey.e}","kty":"RSA","n":"${rsaKey.n}"}`;
  const expected = createHash("sha256").update(canonical).digest("base64url");

  assert.equal(rsaKey.kid, expected, "kid must equal the RFC 7638 thumbprint of the published JWK");
  assert.doesNotMatch(
    rsaKey.kid ?? "",
    /\d{4}-\d{2}/u,
    "kid must not embed any YYYY-MM component — that was the month-rollover bug",
  );

  // Silence the unused variable lint: privateKey is only needed in the sibling
  // test below. Having both in one fixture factoring would require refactoring
  // the shared helpers, so we keep them separate for clarity.
  void privateKey;
});

test("Signed RS256 token header.kid equals the published JWKS RSA kid (month-rollover regression)", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const nowSeconds = 1_900_000_000;
  const claims: RelayAuthTokenClaims = {
    sub: "agent_kid_match",
    org: "org_kid_match",
    wks: "ws_kid_match",
    scopes: ["specialist:invoke"],
    sponsorId: "user_kid_match",
    sponsorChain: ["user_kid_match", "agent_kid_match"],
    token_type: "access",
    iss: "https://relayauth.dev",
    aud: ["specialist"],
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    jti: "tok_kid_match",
  };

  const token = await signToken(claims, {
    RELAYAUTH_SIGNING_KEY_PEM: privateKeyPem,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: publicKeyPem,
  });
  const header = JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
  ) as { kid?: string };

  const jwksResponse = await requestJwks({ RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: publicKeyPem });
  const jwksBody = await assertJsonResponse<{ keys: JsonWebKey[] }>(jwksResponse, 200);
  const rsaJwk = jwksBody.keys.find((key) => key.kty === "RSA");

  assert.ok(rsaJwk, "expected JWKS to publish an RSA JWK");
  assert.equal(
    header.kid,
    rsaJwk.kid,
    "signer kid and JWKS kid must match — otherwise verification breaks at month rollover",
  );
});
