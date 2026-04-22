import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { rsaPublicJwkFromPem } from "../lib/jwk.js";
import { keyIdFromPublicJwk } from "../lib/sign-rs256.js";

const CACHE_CONTROL_HEADER = "public, max-age=3600";

type PublishedJwk = JsonWebKey & {
  kty: string;
  use: string;
  alg: string;
  kid: string;
  n?: string;
  e?: string;
};

const jwks = new Hono<AppEnv>();

jwks.get("/jwks.json", async (c) => {
  const keyId = c.env.SIGNING_KEY_ID;
  const keys: PublishedJwk[] = [
    {
      kty: "oct",
      use: "sig",
      alg: "HS256",
      kid: keyId,
    },
  ];

  // Only expose key metadata (kid, alg), never the symmetric key material.
  // HS256 is a symmetric algorithm — publishing the secret would allow token forgery.
  // Clients needing to verify tokens should use a server-side introspection endpoint.
  const rsaPublicPem = c.env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  if (rsaPublicPem) {
    const rsaKeyWithPlaceholderKid = await rsaPublicJwkFromPem(rsaPublicPem, "");
    const rsaKeyId = await keyIdFromPublicJwk(rsaKeyWithPlaceholderKid);

    keys.push({
      ...rsaKeyWithPlaceholderKid,
      kid: rsaKeyId,
    });
  }

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json({ keys }, 200);
});

export default jwks;
