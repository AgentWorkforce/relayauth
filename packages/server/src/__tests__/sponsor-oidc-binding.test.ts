import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AgentIdentity, SponsorProof } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

const OIDC_KEY_PAIR = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const OIDC_KID = "fixture-rs256-key";
const OIDC_PUBLIC_JWK = {
  ...(OIDC_KEY_PAIR.publicKey.export({ format: "jwk" }) as JsonWebKey),
  alg: "RS256",
  use: "sig",
  kid: OIDC_KID,
};

type ApiKeyCreateResponse = {
  key: string;
};

type CreatedIdentity = AgentIdentity & {
  sponsorId: string;
  sponsorChain: string[];
};

function signIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: OIDC_KID }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), OIDC_KEY_PAIR.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

async function startOidcFixture(t: test.TestContext): Promise<{ issuer: string }> {
  let issuer = "";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "public, max-age=60");
    if (request.url === "/.well-known/openid-configuration") {
      response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [OIDC_PUBLIC_JWK] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { issuer };
}

function adminAuthorization(org: string): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken({
      sub: "agent_admin",
      org,
      wks: "ws_oidc",
      sponsorId: "user_admin",
      sponsorChain: ["user_admin", "agent_admin"],
      scopes: ["*"],
    })}`,
  };
}

async function createWorkspaceApiKey(
  app: ReturnType<typeof createTestApp>,
  org: string,
): Promise<string> {
  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/api-keys",
      { name: "oidc-bootstrap", scopes: ["relayauth:identity:manage:*"] },
      adminAuthorization(org),
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<ApiKeyCreateResponse>(response, 201);
  return body.key;
}

test("OIDC-bound org accepts verified sponsor proof and records binding evidence", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_bound";
  const app = createTestApp({
    RELAYAUTH_SPONSOR_FEDERATIONS: JSON.stringify({
      [org]: {
        sponsorBinding: "oidc",
        issuer,
        clientId: "chief-fixture",
        sponsorIdClaim: "sub",
      },
    }),
  });
  const apiKey = await createWorkspaceApiKey(app, org);
  const now = Math.floor(Date.now() / 1000);
  const idToken = signIdToken({
    iss: issuer,
    sub: "alice",
    aud: "chief-fixture",
    iat: now,
    exp: now + 300,
    jti: "idp-session-1",
  });

  const proofResponse = await app.request(
    createTestRequest(
      "POST",
      "/v1/sponsors/proof",
      { idToken },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const proof = await assertJsonResponse<SponsorProof>(proofResponse, 201);
  assert.equal(proofResponse.headers.get("cache-control"), "no-store");
  assert.equal(proof.sponsorId, "user_alice");

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "verified-agent",
        sponsorId: proof.sponsorId,
        sponsorProof: proof.sponsorProof,
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const identity = await assertJsonResponse<CreatedIdentity>(response, 201);
  assert.equal(identity.sponsorId, "user_alice");
  assert.deepEqual(identity.sponsorChain, ["user_alice", identity.id]);
  assert.deepEqual(identity.sponsorBinding, {
    mode: "oidc",
    issuer,
    subject: "alice",
    iat: now,
    jti: "idp-session-1",
  });

  const storedResponse = await app.request(
    createTestRequest("GET", `/v1/identities/${identity.id}`, undefined, adminAuthorization(org)),
    undefined,
    app.bindings,
  );
  const stored = await assertJsonResponse<CreatedIdentity>(storedResponse, 200);
  assert.deepEqual(stored.sponsorBinding, identity.sponsorBinding);
});

test("OIDC-bound org refuses workspace API key creation without sponsor proof", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_requires_proof";
  const app = createTestApp({
    RELAYAUTH_SPONSOR_FEDERATIONS: JSON.stringify({
      [org]: { sponsorBinding: "oidc", issuer, clientId: "chief-fixture" },
    }),
  });
  const apiKey = await createWorkspaceApiKey(app, org);

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "missing-proof", sponsorId: "user_alice" },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code: string }>(response, 403);
  assert.equal(body.code, "sponsor_proof_required");
});

test("OIDC-bound org refuses sponsorId that differs from verified proof", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_subject_match";
  const app = createTestApp({
    RELAYAUTH_SPONSOR_FEDERATIONS: JSON.stringify({
      [org]: { sponsorBinding: "oidc", issuer, clientId: "chief-fixture" },
    }),
  });
  const apiKey = await createWorkspaceApiKey(app, org);
  const now = Math.floor(Date.now() / 1000);
  const proofResponse = await app.request(
    createTestRequest(
      "POST",
      "/v1/sponsors/proof",
      {
        idToken: signIdToken({
          iss: issuer,
          sub: "alice",
          aud: "chief-fixture",
          iat: now,
          exp: now + 300,
        }),
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const proof = await assertJsonResponse<SponsorProof>(proofResponse, 201);

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "mismatched-sponsor",
        sponsorId: "user_bob",
        sponsorProof: proof.sponsorProof,
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code: string }>(response, 403);
  assert.equal(body.code, "invalid_sponsor_proof");
});

test("legacy org creation remains unchanged and surfaces legacy binding mode", async (t) => {
  const org = "org_legacy_binding";
  const app = createTestApp();
  const apiKey = await createWorkspaceApiKey(app, org);

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "legacy-agent", sponsorId: "user_legacy" },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const identity = await assertJsonResponse<CreatedIdentity>(response, 201);
  assert.equal(identity.sponsorId, "user_legacy");
  assert.deepEqual(identity.sponsorBinding, { mode: "legacy" });
});

test("sponsor proof refuses an id_token with the wrong audience", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_audience";
  const app = createTestApp({
    RELAYAUTH_SPONSOR_FEDERATIONS: JSON.stringify({
      [org]: { sponsorBinding: "oidc", issuer, clientId: "chief-fixture" },
    }),
  });
  const apiKey = await createWorkspaceApiKey(app, org);
  const now = Math.floor(Date.now() / 1000);

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/sponsors/proof",
      {
        idToken: signIdToken({
          iss: issuer,
          sub: "alice",
          aud: "different-client",
          iat: now,
          exp: now + 300,
        }),
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code: string }>(response, 403);
  assert.equal(body.code, "invalid_id_token");
});
