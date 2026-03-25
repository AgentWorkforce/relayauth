import assert from "node:assert/strict";
import test from "node:test";
import type { JWKSResponse, RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError, TokenExpiredError } from "../errors.js";
import { TokenVerifier, type VerifyOptions } from "../verify.js";

type CompleteVerifyOptions = VerifyOptions & {
  cacheTtlMs?: number;
  checkRevocation?: boolean;
  revocationUrl?: string;
};

type TokenVerifierInstance = {
  verify?: (token: string) => Promise<RelayAuthTokenClaims>;
  verifyAndCheckScope?: (token: string, requiredScope: string) => Promise<RelayAuthTokenClaims>;
};

type SigningFixture = {
  kid: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
};

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const fixedNowSeconds = 1_900_000_000;
const jwksUrl = "https://relay.example.test/.well-known/jwks.json";
const revocationUrl = "https://relay.example.test/v1/tokens/revocation";
const signingFixturesPromise = Promise.all([
  createSigningFixture("kid-primary"),
  createSigningFixture("kid-rotated"),
]);

function getVerifier(options?: CompleteVerifyOptions): TokenVerifierInstance {
  return new TokenVerifier(options) as unknown as TokenVerifierInstance;
}

function requireVerify(verifier: TokenVerifierInstance): (token: string) => Promise<RelayAuthTokenClaims> {
  assert.equal(typeof verifier.verify, "function", "TokenVerifier should implement verify(token)");
  return verifier.verify!.bind(verifier);
}

function requireVerifyAndCheckScope(
  verifier: TokenVerifierInstance,
): (token: string, requiredScope: string) => Promise<RelayAuthTokenClaims> {
  assert.equal(
    typeof verifier.verifyAndCheckScope,
    "function",
    "TokenVerifier should implement verifyAndCheckScope(token, requiredScope)",
  );
  return verifier.verifyAndCheckScope!.bind(verifier);
}

function createClaims(
  overrides: Partial<RelayAuthTokenClaims> = {},
  nowSeconds = fixedNowSeconds,
): RelayAuthTokenClaims {
  return {
    sub: "agent_123",
    org: "org_123",
    wks: "ws_123",
    scopes: ["relaycast:channel:read:*"],
    sponsorId: "user_123",
    sponsorChain: ["user_123", "svc_gateway"],
    token_type: "access",
    iss: "https://relay.example.test",
    aud: ["relaycast", "relay-api"],
    exp: nowSeconds + 3600,
    iat: nowSeconds - 60,
    jti: "jti_123",
    ...overrides,
  };
}

async function createSigningFixture(kid: string): Promise<SigningFixture> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey) as JsonWebKey & {
    alg?: string;
    kid?: string;
    use?: string;
  };
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  return {
    kid,
    publicJwk,
    privateKey,
  };
}

function encodeBase64Url(value: string | Buffer | Uint8Array | ArrayBuffer): string {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8").toString("base64url");
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value)).toString("base64url");
  }

  return Buffer.from(value).toString("base64url");
}

async function createJwt(claims: RelayAuthTokenClaims, fixture: SigningFixture): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: fixture.kid,
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    fixture.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${encodeBase64Url(signature)}`;
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
): { calls: FetchCall[]; restore: () => void } {
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

function mockNow(t: test.TestContext, nowMs: { value: number }): void {
  const originalNow = Date.now;
  Date.now = () => nowMs.value;
  t.after(() => {
    Date.now = originalNow;
  });
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

function assertRelayAuthError(
  error: unknown,
  expectedCode?: string,
): error is RelayAuthError {
  assert.ok(error instanceof RelayAuthError, "expected a RelayAuthError instance");
  if (expectedCode) {
    assert.equal(error.code, expectedCode);
  }
  return true;
}

test("verify(token) decodes a JWT, fetches JWKS, verifies the signature, and returns claims", async (t) => {
  const [{ publicJwk, privateKey, kid }] = await signingFixturesPromise;
  void privateKey;
  const claims = createClaims();
  const token = await createJwt(claims, { publicJwk, privateKey, kid });
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch((input) => {
    assert.equal(String(input), jwksUrl);
    return jsonResponse({ keys: [publicJwk] satisfies JWKSResponse["keys"] });
  });
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
  });
  const verify = requireVerify(verifier);

  const result = await verify(token);

  assert.deepEqual(result, claims);
  assert.equal(fetchMock.calls.length, 1);
});

test("JWKS caching reuses cached keys on the second verify call", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_cached" });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
    cacheTtlMs: 5 * 60 * 1000,
  });
  const verify = requireVerify(verifier);

  const first = await verify(token);
  const second = await verify(token);

  assert.deepEqual(first, claims);
  assert.deepEqual(second, claims);
  assert.equal(fetchMock.calls.length, 1);
});

test("JWKS cache expiry re-fetches JWKS after the TTL elapses", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_cache_expiry" });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
    cacheTtlMs: 50,
  });
  const verify = requireVerify(verifier);

  await verify(token);
  now.value += 51;
  await verify(token);

  assert.equal(fetchMock.calls.length, 2);
});

test("key rotation uses the token header kid to select the correct JWKS key", async (t) => {
  const [oldFixture, rotatedFixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_rotated" });
  const token = await createJwt(claims, rotatedFixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({
      keys: [oldFixture.publicJwk, rotatedFixture.publicJwk] satisfies JWKSResponse["keys"],
    }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
  });
  const verify = requireVerify(verifier);

  const result = await verify(token);

  assert.deepEqual(result, claims);
  assert.equal(fetchMock.calls.length, 1);
});

test("expired tokens throw TokenExpiredError", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({
    jti: "jti_expired",
    exp: fixedNowSeconds - 1,
  });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
  });
  const verify = requireVerify(verifier);

  await assert.rejects(() => verify(token), TokenExpiredError);
});

test("an invalid signature throws RelayAuthError", async (t) => {
  const [fixture, differentFixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_bad_signature" });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const mismatchedJwk = { ...differentFixture.publicJwk, kid: fixture.kid };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [mismatchedJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
  });
  const verify = requireVerify(verifier);

  await assert.rejects(
    () => verify(token),
    (error) => assertRelayAuthError(error, "invalid_token"),
  );
});

test("a wrong audience throws RelayAuthError", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_wrong_audience", aud: ["relayfile"] });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
  });
  const verify = requireVerify(verifier);

  await assert.rejects(
    () => verify(token),
    (error) => assertRelayAuthError(error, "invalid_token"),
  );
});

test("a wrong issuer throws RelayAuthError", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_wrong_issuer" });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: "https://unexpected-issuer.example.test",
    audience: ["relaycast"],
  });
  const verify = requireVerify(verifier);

  await assert.rejects(
    () => verify(token),
    (error) => assertRelayAuthError(error, "invalid_token"),
  );
});

test("verifyAndCheckScope(token, requiredScope) verifies the token before enforcing scope access", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({
    jti: "jti_scope_check",
    scopes: ["relaycast:*:*:*"],
  });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch(() =>
    jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] }),
  );
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
  });
  const verifyAndCheckScope = requireVerifyAndCheckScope(verifier);

  const result = await verifyAndCheckScope(token, "relaycast:channel:read:general");

  assert.deepEqual(result, claims);
  assert.equal(fetchMock.calls.length, 1);
});

test("revocation checking calls the revocation endpoint when enabled", async (t) => {
  const [fixture] = await signingFixturesPromise;
  const claims = createClaims({ jti: "jti_revocation_check" });
  const token = await createJwt(claims, fixture);
  const now = { value: fixedNowSeconds * 1000 };
  const fetchMock = mockFetch((input, init) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? new URL(input.toString())
          : new URL(input.url);

    if (url.toString() === jwksUrl) {
      return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
    }

    if (url.toString().startsWith(revocationUrl)) {
      return jsonResponse({ revoked: false });
    }

    assert.fail(`unexpected fetch request: ${url.toString()} ${init?.method ?? "GET"}`);
  });
  t.after(() => fetchMock.restore());
  mockNow(t, now);

  const verifier = getVerifier({
    jwksUrl,
    issuer: claims.iss,
    audience: ["relaycast"],
    checkRevocation: true,
    revocationUrl,
  });
  const verify = requireVerify(verifier);

  const result = await verify(token);

  assert.deepEqual(result, claims);
  assert.equal(fetchMock.calls.length, 2);

  const revocationCall = await inspectCall(fetchMock.calls[1]);
  assert.ok(
    revocationCall.url.toString().startsWith(revocationUrl),
    "expected revocation check to call the configured revocation endpoint",
  );

  const queryJti = revocationCall.url.searchParams.get("jti");
  const bodyJti = revocationCall.body ? JSON.parse(revocationCall.body).jti : undefined;
  assert.equal(queryJti ?? bodyJti, claims.jti);
});
