import { matchScope } from "@relayauth/sdk";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { authenticateAndAuthorizeFromContext } from "../lib/auth.js";
import { SponsorBindingError } from "../lib/sponsor-binding.js";

type SponsorProofRequest = {
  idToken?: unknown;
  id_token?: unknown;
};

const sponsors = new Hono<AppEnv>();

sponsors.post("/proof", async (c) => {
  const auth = await authenticateAndAuthorizeFromContext(
    c,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const body = await c.req.json<SponsorProofRequest>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }
  const tokenValue = body.idToken ?? body.id_token;
  const idToken = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (!idToken) {
    return c.json({ error: "idToken is required", code: "id_token_required" }, 400);
  }

  const service = c.get("sponsorOidcService");
  try {
    const config = service.resolveConfig(c.env, auth.claims.org);
    if (config.sponsorBinding !== "oidc") {
      return c.json({
        error: "OIDC sponsor binding is not enabled for this organization",
        code: "sponsor_binding_not_enabled",
      }, 400);
    }

    const sponsor = await service.verifyIdToken(idToken, config);
    const proof = await service.issueSponsorProof(c.env, auth.claims.org, sponsor, config);
    return c.json(proof, 201);
  } catch (error) {
    if (error instanceof SponsorBindingError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    const requestId = c.get("requestId");
    console.error("RelayAuth sponsor proof failed", {
      requestId,
      orgId: auth.claims.org,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to create sponsor proof", code: "sponsor_proof_failed", requestId }, 503);
  }
});

export default sponsors;
