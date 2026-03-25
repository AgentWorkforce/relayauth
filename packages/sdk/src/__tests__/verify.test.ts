import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  return vi.fn(async (input: RequestInfo | URL) => {
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
      expect(verifier).toBeInstanceOf(TokenVerifier);
      expect(verifier.options).toEqual({ issuer: "relayauth:test" });
    });

    it("can be instantiated without options", () => {
      const verifier = new TokenVerifier();
      expect(verifier).toBeInstanceOf(TokenVerifier);
      expect(verifier.options).toBeUndefined();
    });

    it("preserves all options", () => {
      const opts: VerifyOptions = {
        jwksUrl: "https://auth.example.com/.well-known/jwks.json",
        issuer: "relayauth:prod",
        audience: ["api.example.com", "admin.example.com"],
        maxAge: 3600,
      };
      const verifier = new TokenVerifier(opts);
      expect(verifier.options).toEqual(opts);
    });

    it("accepts empty audience array", () => {
      const verifier = new TokenVerifier({ audience: [] });
      expect(verifier.options?.audience).toEqual([]);
    });

    it("options are readonly", () => {
      const verifier = new TokenVerifier({ issuer: "test" });
      expect(verifier.options?.issuer).toBe("test");
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
      expect(claims.sub).toBe("identity-1");
      expect(claims.org).toBe("org-1");
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

      await expect(verifier.verify(token)).rejects.toThrow(RelayAuthError);
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
      expect(claims.sub).toBe("identity-1");
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

      await expect(verifier.verify(token)).rejects.toThrow(TokenExpiredError);
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

      await expect(verifier.verify(token)).rejects.toThrow(TokenExpiredError);
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

      await expect(verifier.verify(token)).rejects.toThrow(RelayAuthError);
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
      expect(claims.aud).toContain("api.example.com");
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

      await expect(verifier.verify(token)).rejects.toThrow(RelayAuthError);
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

      await expect(verifier.verify(fakeToken)).rejects.toThrow(RelayAuthError);
    });

    it("rejects none algorithm", async () => {
      const header = encodeJsonBase64Url({ alg: "none", typ: "JWT" });
      const payload = encodeJsonBase64Url(validClaims);
      const fakeToken = `${header}.${payload}.`;

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await expect(verifier.verify(fakeToken)).rejects.toThrow(RelayAuthError);
    });

    it("rejects tokens with missing typ header", async () => {
      const header = encodeJsonBase64Url({ alg: "RS256" });
      const payload = encodeJsonBase64Url(validClaims);
      const fakeToken = `${header}.${payload}.fakesig`;

      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });

      await expect(verifier.verify(fakeToken)).rejects.toThrow(RelayAuthError);
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
      await expect(verifier.verify(token)).rejects.toThrow("JWKS URL is required");
    });

    it("throws when JWKS endpoint returns error", async () => {
      globalThis.fetch = vi.fn(async () => new Response("Server Error", { status: 500 }));

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

      await expect(verifier.verify(token)).rejects.toThrow("Failed to fetch JWKS");
    });

    it("refreshes JWKS when key not found", async () => {
      const { privateKey, jwk } = await generateRS256KeyPair();
      const kid = "new-key";
      const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
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
      expect(claims.sub).toBe("identity-1");
      expect(callCount).toBe(2);
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

      await expect(verifier.verify(token)).rejects.toThrow("Token has been revoked");
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
      expect(claims.sub).toBe("identity-1");
    });
  });

  describe("verifyOrNull", () => {
    it("returns null for invalid tokens", async () => {
      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });
      const result = await verifier.verifyOrNull("not.a.token");
      expect(result).toBeNull();
    });
  });

  describe("malformed tokens", () => {
    it("rejects token with wrong number of parts", async () => {
      const verifier = new TokenVerifier({
        jwksUrl: "https://auth.test/.well-known/jwks.json",
      });
      await expect(verifier.verify("only.two")).rejects.toThrow(RelayAuthError);
      await expect(verifier.verify("a.b.c.d")).rejects.toThrow(RelayAuthError);
      await expect(verifier.verify("")).rejects.toThrow(RelayAuthError);
    });
  });
});
