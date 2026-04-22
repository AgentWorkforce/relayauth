import assert from "node:assert/strict";
import { createHmac, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { RelayAuthError } from "../../../sdk/typescript/src/errors.js";
import { TokenVerifier } from "../../../sdk/typescript/src/verify.js";

type SignRs256Module = {
  signRs256: (
    claims: RelayAuthTokenClaims,
    privateKeyPem: string,
    kid: string,
  ) => Promise<string> | string;
};

type SignModule = {
  signToken: (
    claims: RelayAuthTokenClaims,
    env: Record<string, string | undefined>,
  ) => Promise<string> | string;
};

const fixedNowSeconds = 1_900_000_000;

function createClaims(overrides: Partial<RelayAuthTokenClaims> = {}): RelayAuthTokenClaims {
  return {
    sub: "agent_rs256_test",
    org: "org_rs256_test",
    wks: "ws_rs256_test",
    scopes: ["specialist:invoke"],
    sponsorId: "user_rs256_test",
    sponsorChain: ["user_rs256_test", "agent_rs256_test"],
    token_type: "access",
    iss: "https://relayauth.dev",
    aud: ["specialist"],
    exp: fixedNowSeconds + 3600,
    iat: fixedNowSeconds,
    jti: "tok_rs256_test",
    ...overrides,
  };
}

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createRsaFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }).toString();
  const publicKeyPem = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    kid?: string;
    use?: string;
    alg?: string;
  };

  return {
    privateKeyPem,
    publicKeyPem,
    publicJwk,
  };
}

function mockFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    responder(input, init)) as typeof globalThis.fetch;

  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function assertRelayAuthError(error: unknown, code?: string): error is RelayAuthError {
  assert.ok(error instanceof RelayAuthError, "expected RelayAuthError");
  if (code) {
    assert.equal(error.code, code);
  }
  return true;
}

async function loadSignRs256Module(): Promise<SignRs256Module> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../lib/sign-rs256.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected RS256 signing module at ../lib/sign-rs256.js: ${message}`);
  }

  assert.equal(typeof moduleRecord.signRs256, "function", "sign-rs256 module should export signRs256()");
  return moduleRecord as unknown as SignRs256Module;
}

async function loadSignModule(): Promise<SignModule> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../lib/sign.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected signing dispatcher module at ../lib/sign.js: ${message}`);
  }

  assert.equal(typeof moduleRecord.signToken, "function", "sign module should export signToken()");
  return moduleRecord as unknown as SignModule;
}

test("signRs256(claims, privateKeyPem, kid) returns a 3-part JWT with an RS256 header", async () => {
  const { signRs256 } = await loadSignRs256Module();
  const { privateKeyPem } = createRsaFixture();
  const claims = createClaims();
  const kid = "production-2026-04-rs256";

  const token = await signRs256(claims, privateKeyPem, kid);
  const parts = token.split(".");

  assert.equal(parts.length, 3, "expected a compact JWT with 3 dot-separated segments");

  const header = decodeBase64UrlJson<{ alg?: string; typ?: string; kid?: string }>(parts[0]);
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(header.kid, kid);
});

test("signRs256 output verifies through @relayauth/sdk TokenVerifier against the matching RSA JWKS", async (t) => {
  const { signRs256 } = await loadSignRs256Module();
  const { privateKeyPem, publicJwk } = createRsaFixture();
  const kid = "production-2026-04-rs256";
  const token = await signRs256(createClaims(), privateKeyPem, kid);
  const jwk = {
    ...publicJwk,
    kid,
    use: "sig",
    alg: "RS256",
  } satisfies JsonWebKey;
  const fetchMock = mockFetch((input) => {
    assert.equal(String(input), "https://relay.example.test/.well-known/jwks.json");
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });
  t.after(() => fetchMock.restore());

  const verifier = new TokenVerifier({
    jwksUrl: "https://relay.example.test/.well-known/jwks.json",
    issuer: "https://relayauth.dev",
    audience: ["specialist"],
  });

  const verified = await verifier.verify(token);

  assert.equal(verified.sub, "agent_rs256_test");
  assert.deepEqual(verified.aud, ["specialist"]);
});

test("tampering with an RS256 token payload fails verification", async (t) => {
  const { signRs256 } = await loadSignRs256Module();
  const { privateKeyPem, publicJwk } = createRsaFixture();
  const kid = "production-2026-04-rs256";
  const token = await signRs256(createClaims(), privateKeyPem, kid);
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  const tamperedToken = [
    encodedHeader,
    encodeBase64UrlJson({
      ...payload,
      sub: "agent_tampered",
    }),
    encodedSignature,
  ].join(".");
  const jwk = {
    ...publicJwk,
    kid,
    use: "sig",
    alg: "RS256",
  } satisfies JsonWebKey;
  const fetchMock = mockFetch(() =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }));
  t.after(() => fetchMock.restore());

  const verifier = new TokenVerifier({
    jwksUrl: "https://relay.example.test/.well-known/jwks.json",
    issuer: "https://relayauth.dev",
    audience: ["specialist"],
  });

  await assert.rejects(
    () => verifier.verify(tamperedToken),
    (error) => assertRelayAuthError(error, "invalid_token"),
  );
});

test("signToken(claims, env) dispatches to RS256 when RELAYAUTH_SIGNING_ALG=RS256 and otherwise falls back to HS256", async (t) => {
  const { signToken } = await loadSignModule();
  const rs256Fixture = createRsaFixture();
  const rs256Claims = createClaims({ jti: "tok_dispatch_rs256" });

  await t.test("RS256 path", async () => {
    const token = await signToken(rs256Claims, {
      SIGNING_KEY: "legacy-shared-secret",
      SIGNING_KEY_ID: "legacy-production",
      RELAYAUTH_SIGNING_ALG: "RS256",
      RELAYAUTH_SIGNING_KEY_PEM: rs256Fixture.privateKeyPem,
      RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: rs256Fixture.publicKeyPem,
    });

    const [encodedHeader] = token.split(".");
    const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(encodedHeader);

    assert.equal(header.alg, "RS256");
  });

  await t.test("HS256 fallback path", async () => {
    const token = await signToken(createClaims({ jti: "tok_dispatch_hs256" }), {
      SIGNING_KEY: "legacy-shared-secret",
      SIGNING_KEY_ID: "legacy-production",
    });

    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(encodedHeader);
    const expectedSignature = createHmac("sha256", "legacy-shared-secret")
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest("base64url");

    assert.equal(header.alg, "HS256");
    assert.equal(header.kid, "legacy-production");
    assert.equal(encodedSignature, expectedSignature);
  });
});

test("signToken(claims, env) reads RELAYAUTH_SIGNING_KEY_PEM from process.env at RS256 sign time when bindings omit it", async () => {
  const { signToken } = await loadSignModule();
  const rs256Fixture = createRsaFixture();
  const previousPem = process.env.RELAYAUTH_SIGNING_KEY_PEM;

  process.env.RELAYAUTH_SIGNING_KEY_PEM = rs256Fixture.privateKeyPem;

  try {
    const token = await signToken(createClaims({ jti: "tok_dispatch_process_env" }), {
      SIGNING_KEY: "legacy-shared-secret",
      SIGNING_KEY_ID: "legacy-production",
      RELAYAUTH_SIGNING_ALG: "RS256",
      RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: rs256Fixture.publicKeyPem,
    });

    const [encodedHeader] = token.split(".");
    const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(encodedHeader);

    assert.equal(header.alg, "RS256");
    assert.ok(typeof header.kid === "string" && header.kid.length > 0);
  } finally {
    if (previousPem === undefined) {
      delete process.env.RELAYAUTH_SIGNING_KEY_PEM;
    } else {
      process.env.RELAYAUTH_SIGNING_KEY_PEM = previousPem;
    }
  }
});

test("signToken(claims, env) rejects unknown RELAYAUTH_SIGNING_ALG values with a clear error", async () => {
  const { signToken } = await loadSignModule();

  await assert.rejects(
    () => signToken(createClaims({ jti: "tok_dispatch_invalid_alg" }), {
      SIGNING_KEY: "legacy-shared-secret",
      SIGNING_KEY_ID: "legacy-production",
      RELAYAUTH_SIGNING_ALG: "ES256",
    }),
    (error) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Unsupported signing algorithm: ES256/,
      );
      return true;
    },
  );
});
