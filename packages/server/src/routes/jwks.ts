import { Hono } from "hono";
import type { AppEnv } from "../env.js";

const CACHE_CONTROL_HEADER = "public, max-age=3600";

const jwks = new Hono<AppEnv>();

jwks.get("/jwks.json", (c) => {
  const signingKey = c.env.SIGNING_KEY;
  const keyId = c.env.SIGNING_KEY_ID;

  // Encode the HMAC shared secret as a base64url JWK for symmetric key verification.
  // This is used in dev/test mode where HMAC (HS256) signing is active.
  const encodedKey = base64UrlEncode(new TextEncoder().encode(signingKey));

  const jwksResponse = {
    keys: [
      {
        kty: "oct",
        use: "sig",
        alg: "HS256",
        kid: keyId,
        k: encodedKey,
      },
    ],
  };

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json(jwksResponse, 200);
});

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default jwks;
