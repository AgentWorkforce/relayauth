import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { RsaPublicJwk } from "../lib/jwk.js";
import { resolvePublishedSigningKeys } from "../lib/signing-keys.js";

const CACHE_CONTROL_HEADER = "public, max-age=3600";

const jwks = new Hono<AppEnv>();

// Publishes every configured key — current, next and previous — so verifiers
// can validate tokens across a rotation. See docs/self-hosting.md.
jwks.get("/jwks.json", async (c) => {
  const published = await resolvePublishedSigningKeys(c.env ?? {});
  const keys: RsaPublicJwk[] = published.map((key) => key.jwk);

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json({ keys }, 200);
});

export default jwks;
