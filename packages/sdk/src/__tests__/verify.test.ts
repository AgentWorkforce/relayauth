import { describe, expect, it } from "vitest";
import { TokenVerifier } from "../verify.js";
import type { VerifyOptions } from "../verify.js";

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
      // Verify options property is accessible but readonly
      expect(verifier.options?.issuer).toBe("test");
    });
  });

  // TODO: Add these tests once TokenVerifier methods are implemented (workflow 013):
  // describe("verify") — signature verification for RS256 and EdDSA
  // describe("expired tokens") — reject tokens past exp claim
  // describe("audience validation") — reject tokens with wrong audience
  // describe("issuer validation") — reject tokens with wrong issuer
  // describe("algorithm confusion") — reject HS256 tokens when expecting RS256
  // describe("JWKS fetching") — fetch and cache JWKS keys
  // describe("revocation checks") — reject revoked tokens
});
