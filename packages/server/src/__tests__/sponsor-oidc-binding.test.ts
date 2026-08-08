import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AgentIdentity, SponsorProof } from "@relayauth/types";
import { observerBus, type ObserverEvent } from "../lib/events.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
  TEST_RS256_PUBLIC_KEY_PEM,
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
  let identityCreatedEvent: ObserverEvent | undefined;
  const unsubscribe = observerBus.subscribe((event) => {
    if (event.type === "identity.created") {
      identityCreatedEvent = event;
    }
  }, { orgId: org, types: ["identity.created"] });
  t.after(unsubscribe);
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
      { idToken, intent: "identity.create" },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const proof = await assertJsonResponse<SponsorProof>(proofResponse, 201);
  assert.equal(proofResponse.headers.get("cache-control"), "no-store");
  assert.equal(proof.sponsorId, "user_alice");
  assert.equal(proof.intent, "identity.create");
  const [, encodedProofPayload] = proof.sponsorProof.split(".");
  assert.ok(encodedProofPayload);
  assert.equal(
    JSON.parse(Buffer.from(encodedProofPayload, "base64url").toString("utf8")).intent,
    "identity.create",
  );

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
  assert.equal(identityCreatedEvent?.type, "identity.created");
  if (identityCreatedEvent?.type === "identity.created") {
    assert.deepEqual(identityCreatedEvent.payload.sponsorBinding, identity.sponsorBinding);
  }

  const storedResponse = await app.request(
    createTestRequest("GET", `/v1/identities/${identity.id}`, undefined, adminAuthorization(org)),
    undefined,
    app.bindings,
  );
  const stored = await assertJsonResponse<CreatedIdentity>(storedResponse, 200);
  assert.deepEqual(stored.sponsorBinding, identity.sponsorBinding);

  const ledger = await app.storage.DB.prepare(`
    SELECT entry_type, agent_id, sponsor_id, jti, payload_json, jws
    FROM attestation_ledger
    WHERE org_id = ? AND agent_id = ?
  `).bind(org, identity.id).first<{
    entry_type: string;
    agent_id: string;
    sponsor_id: string;
    jti: string | null;
    payload_json: string;
    jws: string;
  }>();
  assert.ok(ledger);
  assert.equal(ledger.entry_type, "identity.created");
  assert.equal(ledger.agent_id, identity.id);
  assert.equal(ledger.sponsor_id, "user_alice");
  assert.equal(ledger.jti, "idp-session-1");
  const [encodedHeader, encodedPayload, encodedSignature] = ledger.jws.split(".");
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  const signedPayloadJson = Buffer.from(encodedPayload, "base64url").toString("utf8");
  assert.equal(signedPayloadJson, ledger.payload_json);
  assert.deepEqual(JSON.parse(ledger.payload_json), {
    agentId: identity.id,
    sponsorId: "user_alice",
    intent: "identity.create",
    issuer,
    subject: "alice",
    iat: now,
    jti: "idp-session-1",
    sponsorBinding: identity.sponsorBinding,
    ts: identity.createdAt,
  });
  assert.equal(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      TEST_RS256_PUBLIC_KEY_PEM,
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );

  const patchResponse = await app.request(
    createTestRequest(
      "PATCH",
      `/v1/identities/${identity.id}`,
      { name: "verified-agent-renamed", sponsorBinding: { mode: "legacy" } },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const patched = await assertJsonResponse<CreatedIdentity>(patchResponse, 200);
  assert.equal(patched.name, "verified-agent-renamed");
  assert.deepEqual(patched.sponsorBinding, identity.sponsorBinding);
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
        intent: "identity.create",
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

test("identity creation refuses a verified-human proof issued for approval", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_intent_bound";
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
        intent: "approval",
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const proof = await assertJsonResponse<SponsorProof>(proofResponse, 201);
  assert.equal(proof.intent, "approval");

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "wrong-intent",
        sponsorId: proof.sponsorId,
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

test("sponsor proof requires a valid intent", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_intent_required";
  const app = createTestApp({
    RELAYAUTH_SPONSOR_FEDERATIONS: JSON.stringify({
      [org]: { sponsorBinding: "oidc", issuer, clientId: "chief-fixture" },
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
  });

  for (const intent of [undefined, "Identity Create", "approval/../../transcript"]) {
    const response = await app.request(
      createTestRequest(
        "POST",
        "/v1/sponsors/proof",
        { idToken, ...(intent === undefined ? {} : { intent }) },
        { "x-api-key": apiKey },
      ),
      undefined,
      app.bindings,
    );
    const body = await assertJsonResponse<{ code: string }>(response, 400);
    assert.equal(body.code, "invalid_sponsor_intent");
  }
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
        intent: "identity.create",
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code: string }>(response, 403);
  assert.equal(body.code, "invalid_id_token");
});

test("malformed sponsor federation configuration fails closed", async () => {
  const org = "org_misconfigured_binding";
  const app = createTestApp({ RELAYAUTH_SPONSOR_FEDERATIONS: "{" });
  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "must-not-fall-back", sponsorId: "user_alice" },
      adminAuthorization(org),
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code: string }>(response, 503);
  assert.equal(body.code, "sponsor_binding_misconfigured");
});

test("OIDC-bound identity creation rolls back when the signed ledger append fails", async (t) => {
  const { issuer } = await startOidcFixture(t);
  const org = "org_oidc_atomic_ledger";
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
        intent: "identity.create",
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const proof = await assertJsonResponse<SponsorProof>(proofResponse, 201);

  await app.storage.DB.prepare(`
    CREATE TRIGGER reject_identity_created_ledger
    BEFORE INSERT ON attestation_ledger
    WHEN NEW.entry_type = 'identity.created'
    BEGIN
      SELECT RAISE(ABORT, 'fixture ledger failure');
    END
  `).run();

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "must-roll-back",
        sponsorId: proof.sponsorId,
        sponsorProof: proof.sponsorProof,
      },
      { "x-api-key": apiKey },
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code: string }>(response, 500);
  assert.equal(body.code, "identity_create_failed");

  const identityRow = await app.storage.DB.prepare(
    "SELECT id FROM identities WHERE org_id = ? AND name = ?",
  ).bind(org, "must-roll-back").first<{ id: string }>();
  const ledgerRow = await app.storage.DB.prepare(
    "SELECT seq FROM attestation_ledger WHERE org_id = ?",
  ).bind(org).first<{ seq: number }>();
  assert.equal(identityRow ?? null, null);
  assert.equal(ledgerRow ?? null, null);
});
