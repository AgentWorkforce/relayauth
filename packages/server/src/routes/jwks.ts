import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { RsaPublicJwk } from "../lib/jwk.js";
import { resolveSessionDirectoryKeys } from "../lib/session-directory-issuer.js";
import { resolvePublishedSigningKeys } from "../lib/signing-keys.js";

const CACHE_CONTROL_HEADER = "public, max-age=3600";
const SESSION_DIRECTORY_CACHE_CONTROL_HEADER = "public, max-age=300";

const jwks = new Hono<AppEnv>();

// Publishes every configured key — current, next and previous — so verifiers
// can validate tokens across a rotation. See docs/self-hosting.md.
jwks.get("/jwks.json", async (c) => {
  const published = await resolvePublishedSigningKeys(c.env ?? {});
  const keys: RsaPublicJwk[] = published.map((key) => key.jwk);

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json({ keys }, 200);
});

// Only this issuer's keys, so PostgREST can be configured to trust nothing else.
// The shorter cache keeps a rotation's waiting period small.
jwks.get("/session-directory/jwks.json", async (c) => {
  const published = await resolveSessionDirectoryKeys(c.env ?? {});
  if (published.length === 0) {
    return c.json({ error: "Not found", code: "not_found" }, 404);
  }
  c.header("Cache-Control", SESSION_DIRECTORY_CACHE_CONTROL_HEADER);
  return c.json({ keys: published.map((key) => key.jwk) }, 200);
});

export default jwks;
