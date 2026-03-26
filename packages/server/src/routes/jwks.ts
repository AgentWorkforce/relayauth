import { Hono } from "hono";
import type { AppEnv } from "../env.js";

const CACHE_CONTROL_HEADER = "public, max-age=3600";

const jwks = new Hono<AppEnv>();

jwks.get("/jwks.json", (c) => {
  const keyId = c.env.SIGNING_KEY_ID;

  // Only expose key metadata (kid, alg), never the symmetric key material.
  // HS256 is a symmetric algorithm — publishing the secret would allow token forgery.
  // Clients needing to verify tokens should use a server-side introspection endpoint.
  const jwksResponse = {
    keys: [
      {
        kty: "oct",
        use: "sig",
        alg: "HS256",
        kid: keyId,
      },
    ],
  };

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json(jwksResponse, 200);
});

export default jwks;
