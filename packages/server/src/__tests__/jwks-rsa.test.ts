import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createApp } from "../server.js";
import type { AppEnv } from "../env.js";
import { assertJsonResponse, createTestRequest, createTestStorage } from "./test-helpers.js";

type ExtendedBindings = AppEnv["Bindings"] & Record<string, string | undefined>;

function createBindings(overrides: Partial<ExtendedBindings> = {}): ExtendedBindings {
  return {
    SIGNING_KEY: "legacy-shared-secret",
    SIGNING_KEY_ID: "legacy-production",
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

test("JWKS keeps the existing HS256 metadata when RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is unset", async () => {
  const response = await requestJwks();
  const body = await assertJsonResponse<{ keys: JsonWebKey[] }>(response, 200);

  assert.deepEqual(body.keys, [
    {
      kty: "oct",
      use: "sig",
      alg: "HS256",
      kid: "legacy-production",
    },
  ]);
});

test("JWKS returns both the legacy HS256 metadata and the RSA public JWK during the transition window", async () => {
  const response = await requestJwks({
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: createPublicKeyPem(),
  });
  const body = await assertJsonResponse<{ keys: JsonWebKey[] }>(response, 200);
  const hs256Key = body.keys.find((key) => key.kty === "oct" && key.alg === "HS256");
  const rsaKey = body.keys.find((key) => key.kty === "RSA" && key.alg === "RS256");

  assert.ok(hs256Key, "expected the legacy HS256 metadata to remain published");
  assert.equal(hs256Key?.kid, "legacy-production");
  assert.ok(rsaKey, "expected the RSA public JWK to be published alongside the HS256 metadata");
  assert.equal(rsaKey?.use, "sig");
  assert.equal("d" in (rsaKey ?? {}), false, "the RSA JWK must not contain private key material");
});
