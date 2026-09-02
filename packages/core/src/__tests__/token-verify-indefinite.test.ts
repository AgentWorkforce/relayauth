import assert from "node:assert/strict";
import { test } from "node:test";
import type { JWKSResponse, RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError, TokenRevokedError } from "../errors.js";
import { TokenVerifier } from "../token-verify.js";

// Focused proof that the core TokenVerifier forces a fail-closed revocation check
// for indefinite (never-expiring) tokens, mirroring the SDK verifier behavior.

const jwksUrl = "https://relay.example.test/.well-known/jwks.json";
const revocationUrl = "https://relay.example.test/v1/tokens/revocation";
const INDEFINITE_EXP = Math.floor(Date.UTC(2100, 0, 1) / 1000);
const nowSeconds = 1_900_000_000;

type SigningFixture = {
  kid: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
};

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
  const publicJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey & {
    alg?: string;
    kid?: string;
    use?: string;
  };
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { kid, publicJwk, privateKey };
}

function encodeBase64Url(value: string | ArrayBuffer): string {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8").toString("base64url");
  }
  return Buffer.from(new Uint8Array(value)).toString("base64url");
}

async function createJwt(
  claims: RelayAuthTokenClaims,
  fixture: SigningFixture,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: fixture.kid };
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(
    JSON.stringify(claims),
  )}`;
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
    headers: { "content-type": "application/json" },
  });
}

function indefiniteClaims(jti: string): RelayAuthTokenClaims {
  return {
    sub: "agent_123",
    org: "org_123",
    wks: "ws_123",
    scopes: ["relayfile:fs:read:/customer/*"],
    sponsorId: "user_123",
    sponsorChain: ["user_123", "agent_123"],
    token_type: "access",
    iss: "https://relay.example.test",
    aud: ["relayfile"],
    exp: INDEFINITE_EXP,
    iat: nowSeconds - 60,
    jti,
    meta: { indefinite: "true", accessTokenClass: "durable" },
  };
}

function withMockedFetchAndNow(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => nowSeconds * 1000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    return responder(url, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  };
}

test("core: indefinite token forces revocation check with default config — rejected after revoke", async (t) => {
  const fixture = await createSigningFixture("kid-core");
  const token = await createJwt(indefiniteClaims("jti_core_indef"), fixture);
  let revoked = false;
  const restore = withMockedFetchAndNow((url) => {
    if (url.toString() === jwksUrl) {
      return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
    }
    if (url.toString().startsWith(revocationUrl)) {
      return jsonResponse({ revoked });
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  });
  t.after(restore);

  // DEFAULT config: checkRevocation NOT set.
  const verifier = new TokenVerifier({
    jwksUrl,
    issuer: "https://relay.example.test",
    audience: ["relayfile"],
    revocationUrl,
  });

  const active = await verifier.verify(token);
  assert.equal(active.jti, "jti_core_indef");

  revoked = true;
  await assert.rejects(
    verifier.verify(token),
    (error: unknown) => error instanceof TokenRevokedError,
  );
});

test("core: indefinite token fails closed with no revocation source", async (t) => {
  const fixture = await createSigningFixture("kid-core2");
  const token = await createJwt(indefiniteClaims("jti_core_norev"), fixture);
  const restore = withMockedFetchAndNow((url) => {
    if (url.toString() === jwksUrl) {
      return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  });
  t.after(restore);

  const verifier = new TokenVerifier({
    jwksUrl,
    issuer: "https://relay.example.test",
    audience: ["relayfile"],
  });

  await assert.rejects(
    verifier.verify(token),
    (error: unknown) =>
      error instanceof RelayAuthError && error.code === "revocation_required",
  );
});

test("core: revocationHandledExternally opts an indefinite token out of the forced check", async (t) => {
  const fixture = await createSigningFixture("kid-core3");
  const token = await createJwt(indefiniteClaims("jti_core_ext"), fixture);
  const restore = withMockedFetchAndNow((url) => {
    if (url.toString() === jwksUrl) {
      return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  });
  t.after(restore);

  const verifier = new TokenVerifier({
    jwksUrl,
    issuer: "https://relay.example.test",
    audience: ["relayfile"],
    revocationHandledExternally: true,
  });

  const result = await verifier.verify(token);
  assert.equal(result.jti, "jti_core_ext");
});

test("core: a 200 revocation response with no boolean `revoked` field fails closed", async (t) => {
  const fixture = await createSigningFixture("kid-core4");
  const token = await createJwt(indefiniteClaims("jti_core_malformed"), fixture);
  const restore = withMockedFetchAndNow((url) => {
    if (url.toString() === jwksUrl) {
      return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
    }
    if (url.toString().startsWith(revocationUrl)) {
      // 200, but no `revoked` field — ambiguous; must not be read as "not revoked".
      return jsonResponse({ status: "ok" });
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  });
  t.after(restore);

  const verifier = new TokenVerifier({
    jwksUrl,
    issuer: "https://relay.example.test",
    audience: ["relayfile"],
    revocationUrl,
  });

  await assert.rejects(
    verifier.verify(token),
    (error: unknown) =>
      error instanceof RelayAuthError && error.code === "invalid_revocation_response",
  );
});

test("core: a stalling revocation source is rejected within the bounded timeout, not hung", async (t) => {
  const fixture = await createSigningFixture("kid-core5");
  const token = await createJwt(indefiniteClaims("jti_core_stall"), fixture);
  const restore = withMockedFetchAndNow((url, init) => {
    if (url.toString() === jwksUrl) {
      return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
    }
    if (url.toString().startsWith(revocationUrl)) {
      // Stall until the bounded timeout aborts the fetch.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }
    throw new Error(`unexpected fetch: ${url.toString()}`);
  });
  t.after(restore);

  const verifier = new TokenVerifier({
    jwksUrl,
    issuer: "https://relay.example.test",
    audience: ["relayfile"],
    revocationUrl,
    revocationTimeoutMs: 50,
  });

  // `AbortSignal.timeout`'s timer is unref'd, so hold the loop open for the test
  // (a real hang would still exceed this and fail).
  const keepAlive = setTimeout(() => {}, 4000);
  const start = performance.now();
  await assert.rejects(
    verifier.verify(token),
    (error: unknown) =>
      error instanceof RelayAuthError && error.code === "revocation_check_failed",
  );
  clearTimeout(keepAlive);
  assert.ok(performance.now() - start < 4000, "verification must not hang");
});

test("core: a fractional or out-of-range revocationTimeoutMs override does not break the check", async (t) => {
  for (const timeout of [50.5, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    const fixture = await createSigningFixture(`kid-core-to-${timeout}`);
    const token = await createJwt(indefiniteClaims(`jti_core_to_${timeout}`), fixture);
    const restore = withMockedFetchAndNow((url) => {
      if (url.toString() === jwksUrl) {
        return jsonResponse({ keys: [fixture.publicJwk] satisfies JWKSResponse["keys"] });
      }
      if (url.toString().startsWith(revocationUrl)) {
        return jsonResponse({ revoked: false });
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    });

    const verifier = new TokenVerifier({
      jwksUrl,
      issuer: "https://relay.example.test",
      audience: ["relayfile"],
      revocationUrl,
      revocationTimeoutMs: timeout,
    });

    // A sanitized (floored + clamped) timeout must still allow a valid,
    // non-revoked token through — it must NOT throw/overflow into a 1ms timer
    // that rejects every check.
    const result = await verifier.verify(token);
    assert.equal(result.jti, `jti_core_to_${timeout}`);
    restore();
  }
});
