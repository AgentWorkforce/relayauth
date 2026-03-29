import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { TokenVerifier } from "../verify.js";
import type { VerifyOptions } from "../verify.js";
import { RelayAuthError, TokenExpiredError } from "../errors.js";

// --- Test Helpers ---

function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJsonBase64Url(obj: Record<string, unknown>): string {
  return base64UrlEncode(JSON.stringify(obj));
}

const validClaims = {
  sub: "identity-1",
  org: "org-1",
  wks: "wks-1",
  scopes: ["relay:agent:read"],
  sponsorId: "sponsor-1",
  sponsorChain: ["sponsor-1"],
  token_type: "access" as const,
  iss: "relayauth:test",
  aud: ["api.example.com"],
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000) - 60,
  jti: "token-id-1",
};

async function generateRS256KeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, jwk };
}

async function generateEdDSAKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, jwk };
}

async function signToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  alg: string,
): Promise<string> {
  const encodedHeader = encodeJsonBase64Url(header);
  const encodedPayload = encodeJsonBase64Url(payload);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);

  const algorithm = alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : { name: "Ed25519" };

  const signature = await crypto.subtle.sign(algorithm, privateKey, signingInput);
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function createMockJwksServer(keys: JsonWebKey[]): string {
  return "https://auth.test/.well-known/jwks.json";
}

function mockFetch(keys: JsonWebKey[], revoked = false) {
  return mock.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("jwks")) {
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }
    if (url.includes("revocation")) {
      return new Response(JSON.stringify({ revoked }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  });
}

// --- Tests ---

describe("TokenVerifier", () => {
  describe("constructor", () => {
    it("can be instantiated with issuer", () => {
      const verifier = new TokenVerifier({ issuer: "relayauth:test" });
      assert.ok(verifier instanceof TokenVerifier);
      assert.deepEqual(verifier.options, { issuer: "relayauth:test" });
    });

    it("can be instantiated without options", () => {
      const verifier = new TokenVerifier();
      assert.ok(verifier instanceof TokenVerifier);
      assert.equal(verifier.options, undefined);
    });

    it("preserves all options", () => {
      const opts: VerifyOptions = {
        jwksUrl: "https://auth.example.com/.well-known/jwks.json",
        issuer: "relayauth:prod",
        audience: ["api.example.com", "admin.example.com"],
        maxAge: 3600,
      };
      const verifier = new TokenVerifier(opts);
      assert.deepEqual(verifier.options, opts);
    });

    it("accepts empty audience array", () => {
      const verifier = new TokenVerifier({ audience: [] });
      assert.deepEqual(verifier.options?.audience, []);
    });

    it("options are readonly", () => {
      const verifier = new TokenVerifier({ issuer: "test" });
      assert.equal(verifier.options?.issuer, "test");
    });
  });

  describe("verify - RS256 signature", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("verifies a valid RS256 token", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        validClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        issuer: "relayauth:test",
        audience: ["api.example.com"],
      });

      const claims = await verifier.verify(token);
      assert.equal(claims.sub, "identity-1");
      assert.equal(claims.org, "org-1");
    });

    it("rejects a token with invalid signature", async () => {
      const { jwk } = await generateRS256KeyPair();
      const { privateKey: wrongKey } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        validClaims,
        wrongKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });
  });

  describe("verify - EdDSA signature", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("verifies a valid EdDSA token", async () => {
      const { privateKey, jwk } = await generateEdDSAKeyPair();
      const kid = "ed-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "EdDSA" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const token = await signToken(
        { alg: "EdDSA", typ: "JWT", kid },
        validClaims,
        privateKey,
        "EdDSA",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        issuer: "relayauth:test",
        audience: ["api.example.com"],
      });

      const claims = await verifier.verify(token);
      assert.equal(claims.sub, "identity-1");
    });
  });

  describe("expired tokens", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects expired tokens", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const expiredClaims = {
        ...validClaims,
        exp: Math.floor(Date.now() / 1000) - 3600,
      };

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        expiredClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok(err instanceof TokenExpiredError); return true; });
    });

    it("rejects tokens exceeding maxAge", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const oldClaims = {
        ...validClaims,
        iat: Math.floor(Date.now() / 1000) - 7200,
      };

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        oldClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        maxAge: 3600,
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok(err instanceof TokenExpiredError); return true; });
    });
  });

  describe("audience validation", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects tokens with wrong audience", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        { ...validClaims, aud: ["other.example.com"] },
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        audience: ["api.example.com"],
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });

    it("accepts tokens when audience matches", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        { ...validClaims, aud: ["api.example.com", "other.example.com"] },
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        audience: ["api.example.com"],
      });

      const claims = await verifier.verify(token);
      assert.ok((claims.aud).includes("api.example.com"));
    });
  });

  describe("issuer validation", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects tokens with wrong issuer", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid]);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        { ...validClaims, iss: "relayauth:wrong" },
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        issuer: "relayauth:test",
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });
  });

  describe("algorithm confusion", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects HS256 tokens", async () => {
      const header = encodeJsonBase64Url({ alg: "HS256", typ: "JWT" });
      const payload = encodeJsonBase64Url(validClaims);
      const fakeToken = `${header}.${payload}.fakesignature`;

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await assert.rejects(async () => { await verifier.verify(fakeToken); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });

    it("rejects none algorithm", async () => {
      const header = encodeJsonBase64Url({ alg: "none", typ: "JWT" });
      const payload = encodeJsonBase64Url(validClaims);
      const fakeToken = `${header}.${payload}.`;

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await assert.rejects(async () => { await verifier.verify(fakeToken); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });

    it("rejects tokens with missing typ header", async () => {
      const header = encodeJsonBase64Url({ alg: "RS256" });
      const payload = encodeJsonBase64Url(validClaims);
      const fakeToken = `${header}.${payload}.fakesig`;

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await assert.rejects(async () => { await verifier.verify(fakeToken); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });
  });

  describe("JWKS fetching", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("throws when JWKS URL is not configured", async () => {
      const { privateKey } = await generateRS256KeyPair();
      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid: "k1" },
        validClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier();
      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok((err as Error).message === "JWKS URL is required"); return true; });
    });

    it("throws when JWKS endpoint returns error", async () => {
      globalThis.fetch = mock.fn(async () => new Response("Server Error", { status: 500 }));

      const { privateKey } = await generateRS256KeyPair();
      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid: "k1" },
        validClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok((err as Error).message.includes("Failed to fetch JWKS")); return true; });
    });

    it("refreshes JWKS when key not found", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "new-key";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      let callCount = 0;
      globalThis.fetch = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ keys: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ keys: [jwkWithKid] }), { status: 200 });
      });

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        validClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        issuer: "relayauth:test",
        audience: ["api.example.com"],
      });

      const claims = await verifier.verify(token);
      assert.equal(claims.sub, "identity-1");
      assert.equal(callCount, 2);
    });
  });

  describe("revocation checks", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("rejects revoked tokens", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid], true);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        validClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        issuer: "relayauth:test",
        audience: ["api.example.com"],
        checkRevocation: true,
        revocationUrl: "https://auth.test/revocation",
      });

      await assert.rejects(async () => { await verifier.verify(token); }, (err) => { assert.ok((err as Error).message === "Token has been revoked"); return true; });
    });

    it("accepts non-revoked tokens", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "test-key-1";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      globalThis.fetch = mockFetch([jwkWithKid], false);

      const token = await signToken(
        { alg: "RS256", typ: "JWT", kid },
        validClaims,
        privateKey,
        "RS256",
      );

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
        issuer: "relayauth:test",
        audience: ["api.example.com"],
        checkRevocation: true,
        revocationUrl: "https://auth.test/revocation",
      });

      const claims = await verifier.verify(token);
      assert.equal(claims.sub, "identity-1");
    });
  });

  describe("verifyOrNull", () => {
    it("returns null for invalid tokens", async () => {
      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });
      const result = await verifier.verifyOrNull("not.a.token");
      assert.equal(result, null);
    });
  });

  describe("malformed tokens", () => {
    it("rejects token with wrong number of parts", async () => {
      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });
      await assert.rejects(async () => { await verifier.verify("only.two"); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
      await assert.rejects(async () => { await verifier.verify("a.b.c.d"); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
      await assert.rejects(async () => { await verifier.verify(""); }, (err) => { assert.ok(err instanceof RelayAuthError); return true; });
    });
  });
});
