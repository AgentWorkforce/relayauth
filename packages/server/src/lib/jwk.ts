import { pemToArrayBuffer } from "./sign-rs256.js";

export { rfc7638Thumbprint } from "./sign-rs256.js";
export type { RsaThumbprintJwk } from "./sign-rs256.js";

export type RsaPublicJwk = JsonWebKey & {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  use: "sig";
  alg: "RS256";
};

export async function rsaPublicJwkFromPem(publicPem: string, kid: string): Promise<RsaPublicJwk> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(publicPem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    true,
    ["verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", publicKey);

  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("Invalid RSA public key: expected RSA modulus and exponent");
  }

  return {
    kty: "RSA",
    n: exported.n,
    e: exported.e,
    kid,
    use: "sig",
    alg: "RS256",
  };
}
