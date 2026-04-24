import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { RelayAuthError } from "../../../sdk/typescript/src/errors.js";
import { TokenVerifier } from "../../../sdk/typescript/src/verify.js";
import { rfc7638Thumbprint } from "../lib/jwk.js";
import { importRsaPrivateKey, keyIdFromPublicJwk } from "../lib/sign-rs256.js";

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

test("signToken(claims, env) signs RS256 tokens only", async () => {
  const { signToken } = await loadSignModule();
  const rs256Fixture = createRsaFixture();
  const rs256Claims = createClaims({ jti: "tok_dispatch_rs256" });

  const token = await signToken(rs256Claims, {
    RELAYAUTH_SIGNING_KEY_PEM: rs256Fixture.privateKeyPem,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: rs256Fixture.publicKeyPem,
  });

  const [encodedHeader] = token.split(".");
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(encodedHeader);

  assert.equal(header.alg, "RS256");
  assert.ok(typeof header.kid === "string" && header.kid.length > 0);
});

test("signToken(claims, env) reads RELAYAUTH_SIGNING_KEY_PEM from process.env at RS256 sign time when bindings omit it", async () => {
  const { signToken } = await loadSignModule();
  const rs256Fixture = createRsaFixture();
  const previousPem = process.env.RELAYAUTH_SIGNING_KEY_PEM;

  process.env.RELAYAUTH_SIGNING_KEY_PEM = rs256Fixture.privateKeyPem;

  try {
    const token = await signToken(createClaims({ jti: "tok_dispatch_process_env" }), {
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

test("signToken(claims, env) requires RS256 private key material", async () => {
  const { signToken } = await loadSignModule();

  await assert.rejects(
    () => signToken(createClaims({ jti: "tok_dispatch_invalid_alg" }), {
      RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: createRsaFixture().publicKeyPem,
    }),
    (error) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /RELAYAUTH_SIGNING_KEY_PEM must be set/,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// kid derivation: RFC 7638 JWK thumbprint
// ---------------------------------------------------------------------------

test("rfc7638Thumbprint matches the RFC 7638 §3.1 known-answer vector", async () => {
  // Exact RSA key from RFC 7638 §3.1. The RFC states the thumbprint is
  // NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs (base64url of the SHA-256
  // digest of the canonical form).
  const rfcJwk = {
    kty: "RSA" as const,
    n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4"
      + "cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiF"
      + "V4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6C"
      + "f0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9"
      + "c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTW"
      + "hAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1"
      + "jF44-csFCur-kEgU8awapJzKnqDKgw",
    e: "AQAB",
  };

  const thumbprint = await rfc7638Thumbprint(rfcJwk);

  assert.equal(thumbprint, "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
});

test("keyIdFromPublicJwk is deterministic: two calls on the same JWK yield the same kid", async () => {
  const { publicJwk } = createRsaFixture();
  const jwk = { kty: "RSA" as const, n: publicJwk.n as string, e: publicJwk.e as string };

  const first = await keyIdFromPublicJwk(jwk);
  const second = await keyIdFromPublicJwk(jwk);

  assert.equal(first, second);
  // Regression: kid must NOT embed the current YYYY-MM month. The old buggy
  // kid format was `<stage>-<YYYY-MM>-<hash8>`; RFC 7638 thumbprints don't
  // contain literal dash-separated month segments.
  assert.doesNotMatch(
    first,
    /^[a-z0-9-]+-\d{4}-\d{2}-[0-9a-f]{8}$/u,
    "kid must not use the legacy YYYY-MM-embedded format",
  );
});

test("keyIdFromPublicJwk is time-independent: kid is stable across month rollover", async (t) => {
  const { publicJwk } = createRsaFixture();
  const jwk = { kty: "RSA" as const, n: publicJwk.n as string, e: publicJwk.e as string };

  // Mock Date to return a timestamp in January 2026.
  const RealDate = Date;
  const januaryMs = RealDate.UTC(2026, 0, 31, 23, 59, 59);
  class MockDateJan extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(januaryMs);
      } else {
        super(...(args as [number]));
      }
    }
    static now() {
      return januaryMs;
    }
  }
  globalThis.Date = MockDateJan as unknown as DateConstructor;
  let kidJan: string;
  try {
    kidJan = await keyIdFromPublicJwk(jwk);
  } finally {
    globalThis.Date = RealDate;
  }

  // Mock Date to return a timestamp in February 2026 (the next month).
  const februaryMs = RealDate.UTC(2026, 1, 1, 0, 0, 1);
  class MockDateFeb extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(februaryMs);
      } else {
        super(...(args as [number]));
      }
    }
    static now() {
      return februaryMs;
    }
  }
  globalThis.Date = MockDateFeb as unknown as DateConstructor;
  let kidFeb: string;
  try {
    kidFeb = await keyIdFromPublicJwk(jwk);
  } finally {
    globalThis.Date = RealDate;
  }

  t.diagnostic(`kid(Jan)=${kidJan} kid(Feb)=${kidFeb}`);
  assert.equal(kidJan, kidFeb, "kid must NOT change across month boundaries");
});

test("keyIdFromPublicJwk agrees with manually computed RFC 7638 thumbprint (hash of canonical JSON)", async () => {
  const { publicJwk } = createRsaFixture();
  const n = publicJwk.n as string;
  const e = publicJwk.e as string;

  const canonical = `{"e":"${e}","kty":"RSA","n":"${n}"}`;
  const expected = createHash("sha256").update(canonical).digest("base64url");

  const kid = await keyIdFromPublicJwk({ kty: "RSA", n, e });

  assert.equal(kid, expected);
});

test("signRs256 header.kid matches the RFC 7638 thumbprint of the public JWK (sign-kid == jwks-kid)", async () => {
  const { signRs256 } = await loadSignRs256Module();
  const { privateKeyPem, publicJwk } = createRsaFixture();
  const expectedKid = await rfc7638Thumbprint({
    kty: "RSA",
    n: publicJwk.n as string,
    e: publicJwk.e as string,
  });

  const token = await signRs256(createClaims({ jti: "tok_kid_match" }), privateKeyPem, expectedKid);
  const header = decodeBase64UrlJson<{ kid?: string }>(token.split(".")[0]);

  assert.equal(header.kid, expectedKid);
});

test("importRsaPrivateKey rejects RSA keys smaller than 2048 bits with a clear error", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  await assert.rejects(
    () => importRsaPrivateKey(privateKeyPem),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /1024 bits/);
      assert.match(message, /at least 2048/i);
      return true;
    },
  );
});
