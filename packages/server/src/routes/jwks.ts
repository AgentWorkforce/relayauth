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
  const keys: PublishedJwk[] = [];

  // HS256 is published as algorithm metadata (kid only — never the secret;
  // publishing the symmetric key would allow token forgery). It only appears
  // when the deployment actually has an HS256 signing secret bound; otherwise
  // the entry is misleading because no token can be signed or verified with
  // an algorithm the server isn't configured for. This gate is what lets a
  // deployment retire HS256 by simply unbinding SIGNING_KEY.
  const hs256Secret = c.env.SIGNING_KEY?.trim();
  if (hs256Secret) {
    keys.push({
      kty: "oct",
      use: "sig",
      alg: "HS256",
      kid: c.env.SIGNING_KEY_ID,
    });
  }

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
