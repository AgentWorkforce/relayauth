import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { hashApiKey } from "../lib/api-keys.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  seedStoredIdentity,
} from "./test-helpers.js";

type GrantResponse = {
  jti: string;
  finalizeKey: string;
  sponsorChain: string[];
  late: boolean;
};

type FinalizeResponse = {
  attestations: Array<{ sha: string; jws: string }>;
};

type PublishedJwk = JsonWebKey & { kid: string };

function createIdentity(): StoredIdentity {
  const base = generateTestIdentity({
    id: "agent_attestation",
    orgId: "org_attestation",
  });
  return {
    ...base,
    workspaceId: "ws_attestation",
    sponsorId: "user_attestation_owner",
    sponsorChain: ["user_attestation_owner", base.id],
  };
}

async function installLedgerStub(app: ReturnType<typeof createTestApp>): Promise<void> {
  await app.storage.DB.exec(`
    CREATE TABLE IF NOT EXISTS attestation_ledger (
      seq INTEGER PRIMARY KEY,
      org_id TEXT NOT NULL,
      org_seq INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      jws TEXT NOT NULL,
      prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
      entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (org_id, org_seq),
      UNIQUE (org_id, entry_hash)
    );
  `);
}

async function createWorkspaceGrantClient(
  scopes = ["relayauth:attest:grant:*"],
  forceMemory = false,
) {
  const app = createTestApp({}, forceMemory
    ? { storage: createSqliteStorage(undefined, { forceMemory: true }) }
    : {});
  await installLedgerStub(app);
  const key = "ra_ws_attestation_test_key";
  await app.storage.apiKeys.create({
    orgId: "org_attestation",
    name: "attestation workspace key",
    prefix: "ra_ws_",
    keyHash: hashApiKey(key),
    scopes,
    kind: "workspace_token",
    workspaceId: "ws_attestation",
  });
  await seedStoredIdentity(app, createIdentity());
  return { app, key };
}

async function grant(
  app: ReturnType<typeof createTestApp>,
  key: string,
  body: Record<string, unknown> = {},
): Promise<GrantResponse> {
  const response = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/grants",
    { agentId: "agent_attestation", repo: "AgentWorkforce/example", ...body },
    { "x-api-key": key },
  ));
  return assertJsonResponse<GrantResponse>(response, 201);
}

async function verifyWithPublishedJwks(
  app: ReturnType<typeof createTestApp>,
  jws: string,
): Promise<Record<string, unknown>> {
  const [encodedHeader, encodedPayload, encodedSignature] = jws.split(".");
  assert.ok(encodedHeader && encodedPayload && encodedSignature, "expected a compact JWS");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  assert.equal(header.alg, "RS256");
  const response = await app.fetch(createTestRequest("GET", "/.well-known/jwks.json"));
  const jwks = await assertJsonResponse<{ keys: PublishedJwk[] }>(response, 200);
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
  assert.ok(jwk, "signed attestation kid must be published by JWKS");
  assert.equal(crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  ), true);
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("grant snapshots sponsorship and finalizes two JWKS-verifiable commits once", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const issued = await grant(app, key);
  assert.deepEqual(issued.sponsorChain, ["user_attestation_owner", "agent_attestation"]);

  const stored = await app.storage.DB.prepare(
    "SELECT finalize_key_hash FROM attestation_grants WHERE jti = ?",
  ).bind(issued.jti).first<{ finalize_key_hash: string }>();
  assert.equal(stored?.finalize_key_hash.length, 64);
  assert.notEqual(stored?.finalize_key_hash, issued.finalizeKey);

  const response = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    {
      jti: issued.jti,
      commits: [{ sha: "a".repeat(40) }, { sha: "b".repeat(40) }],
    },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  const finalized = await assertJsonResponse<FinalizeResponse>(response, 201);
  assert.equal(finalized.attestations.length, 2);
  for (const [index, attestation] of finalized.attestations.entries()) {
    const payload = await verifyWithPublishedJwks(app, attestation.jws);
    assert.deepEqual(payload, {
      commitSha: (index === 0 ? "a" : "b").repeat(40),
      agentId: "agent_attestation",
      sponsorId: "user_attestation_owner",
      sponsorChain: ["user_attestation_owner", "agent_attestation"],
      repo: "AgentWorkforce/example",
      ts: payload.ts,
      jti: issued.jti,
    });
  }

  const replay = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "c".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  await assertJsonResponse<{ code: string }>(replay, 409, (body) => {
    assert.equal(body.code, "attestation_grant_redeemed");
  });
});

test("finalize rejects the wrong key and an expired grant", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const issued = await grant(app, key);

  const wrongKey = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "d".repeat(40) }] },
    { authorization: "Bearer wrong-finalize-key" },
  ));
  await assertJsonResponse<{ code: string }>(wrongKey, 401, (body) => {
    assert.equal(body.code, "invalid_finalize_key");
  });

  await app.storage.DB.prepare(
    "UPDATE attestation_grants SET not_after = ? WHERE jti = ?",
  ).bind(new Date(Date.now() - 1_000).toISOString(), issued.jti).run();
  const expired = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "e".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  await assertJsonResponse<{ code: string }>(expired, 410, (body) => {
    assert.equal(body.code, "attestation_grant_expired");
  });
});

test("an opaque sessionRef is signed when the dispatcher supplies one", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const issued = await grant(app, key, { sessionRef: "sessionref_opaque_01" });
  const response = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "9".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  const finalized = await assertJsonResponse<FinalizeResponse>(response, 201);
  const payload = await verifyWithPublishedJwks(app, finalized.attestations[0]!.jws);
  assert.equal(payload.sessionRef, "sessionref_opaque_01");
  assert.equal("sessionId" in payload, false);
});

test("ledger append failure returns 5xx and leaves the grant redeemable", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const issued = await grant(app, key);
  await app.storage.DB.exec(`
    CREATE TRIGGER fail_attestation_append
    BEFORE INSERT ON attestation_ledger
    BEGIN
      SELECT RAISE(ABORT, 'simulated append failure');
    END;
  `);

  const failed = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "f".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  assert.equal(failed.status, 500);
  const afterFailure = await app.storage.DB.prepare(
    "SELECT redeemed_at FROM attestation_grants WHERE jti = ?",
  ).bind(issued.jti).first<{ redeemed_at: string | null }>();
  assert.equal(afterFailure?.redeemed_at, null);

  await app.storage.DB.exec("DROP TRIGGER fail_attestation_append");
  const retry = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "f".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  await assertJsonResponse<FinalizeResponse>(retry, 201);
});

test("late grants require an operator API key and are flagged", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const workspaceAttempt = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/grants",
    { agentId: "agent_attestation", repo: "AgentWorkforce/example", late: true },
    { "x-api-key": key },
  ));
  await assertJsonResponse<{ code: string }>(workspaceAttempt, 403, (body) => {
    assert.equal(body.code, "operator_api_key_required");
  });

  const operatorKey = "ra_operator_attestation_test_key";
  await app.storage.apiKeys.create({
    orgId: "org_attestation",
    name: "attestation operator key",
    prefix: "ra_",
    keyHash: hashApiKey(operatorKey),
    scopes: ["relayauth:attest:grant:*"],
  });
  const late = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/grants",
    { agentId: "agent_attestation", repo: "AgentWorkforce/example", late: true },
    { "x-api-key": operatorKey },
  ));
  await assertJsonResponse<GrantResponse>(late, 201, (body) => {
    assert.equal(body.late, true);
  });
});

test("forced-memory storage preserves atomic finalize behavior", async (t) => {
  const { app, key } = await createWorkspaceGrantClient(
    ["relayauth:attest:grant:*"],
    true,
  );
  t.after(() => app.close());
  const issued = await grant(app, key);
  const finalized = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "8".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  await assertJsonResponse<FinalizeResponse>(finalized, 201);

  const replay = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "7".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  await assertJsonResponse<{ code: string }>(replay, 409);
});
