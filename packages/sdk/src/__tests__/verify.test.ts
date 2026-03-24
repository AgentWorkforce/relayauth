import { describe, expect, it } from "vitest";
import { TokenVerifier } from "../verify.js";

describe("TokenVerifier", () => {
  it("can be instantiated", () => {
    const verifier = new TokenVerifier({ issuer: "relayauth:test" });
    expect(verifier).toBeInstanceOf(TokenVerifier);
    expect(verifier.options).toEqual({ issuer: "relayauth:test" });
  });
});
