import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { purgeExpiredEntries } from "../engine/audit-retention.js";
import { hashApiKey } from "../lib/api-keys.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  seedStoredIdentity,
  TEST_RS256_PUBLIC_KEY_PEM,
} from "./test-helpers.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import { ATTESTATION_LEDGER_GENESIS_HASH } from "../storage/interface.js";

type GrantResponse = {
  jti: string;
  finalizeKey: string;
  notAfter: string;
};

type FinalizeResponse = {
  attestations: Array<{ sha: string; jws: string }>;
};

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

async function createWorkspaceGrantClient(scopes = ["relayauth:attest:grant:*"]) {
  const app = createTestApp();
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

function verifyJws(jws: string): Record<string, unknown> {
  const [header, payload, signature] = jws.split(".");
  assert.ok(header && payload && signature, "expected a compact JWS");
  assert.equal(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      TEST_RS256_PUBLIC_KEY_PEM,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("grant snapshots identity sponsorship and finalizes two verifiable attestations", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const issued = await grant(app, key, { taskRef: "task-123" });

  const response = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    {
      jti: issued.jti,
      commits: [
        { sha: "a".repeat(40) },
        { sha: "b".repeat(40) },
      ],
    },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  const finalized = await assertJsonResponse<FinalizeResponse>(response, 201);
  assert.equal(finalized.attestations.length, 2);
  const payload = verifyJws(finalized.attestations[0]!.jws);
  assert.deepEqual(payload, {
    agentId: "agent_attestation",
    commitSha: "a".repeat(40),
    jti: issued.jti,
    repo: "AgentWorkforce/example",
    sponsorChain: ["user_attestation_owner", "agent_attestation"],
    sponsorId: "user_attestation_owner",
    ts: payload.ts,
  });

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

test("finalize rejects a wrong key and an expired grant", async (t) => {
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

  const expired = await app.storage.attestations.getGrant(issued.jti);
  assert.ok(expired);
  await app.storage.DB.prepare(
    "UPDATE attestation_grants SET not_after = ? WHERE jti = ?",
  ).bind(new Date(Date.now() - 1_000).toISOString(), issued.jti).run();
  const expiredFinalize = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "e".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  await assertJsonResponse<{ code: string }>(expiredFinalize, 410, (body) => {
    assert.equal(body.code, "attestation_grant_expired");
  });
});

test("ledger chains are independent for each organization", async (t) => {
  const { app } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const first = await app.storage.attestations.appendAttestationLedgerEntry({
    orgId: "org_chain_a",
    entryType: "checkpoint",
    payload: { event: "first" },
    jws: "test-jws-a1",
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  const second = await app.storage.attestations.appendAttestationLedgerEntry({
    orgId: "org_chain_a",
    entryType: "checkpoint",
    payload: { event: "second" },
    jws: "test-jws-a2",
    createdAt: "2000-01-01T00:00:01.000Z",
  });
  const independent = await app.storage.attestations.appendAttestationLedgerEntry({
    orgId: "org_chain_b",
    entryType: "checkpoint",
    payload: { event: "first" },
    jws: "test-jws-b1",
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(first.orgSeq, 1);
  assert.equal(first.prevHash, ATTESTATION_LEDGER_GENESIS_HASH);
  assert.equal(second.orgSeq, 2);
  assert.equal(second.prevHash, first.entryHash);
  assert.equal(independent.orgSeq, 1);
  assert.equal(independent.prevHash, ATTESTATION_LEDGER_GENESIS_HASH);
});

test("ledger failure returns 5xx and leaves the grant unredeemed", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  const issued = await grant(app, key);
  await app.storage.DB.exec(`
    CREATE TRIGGER fail_attestation_issue
    BEFORE INSERT ON attestation_ledger
    WHEN NEW.entry_type = 'attestation.issued'
    BEGIN
      SELECT RAISE(ABORT, 'simulated append failure');
    END;
  `);

  const response = await app.fetch(createTestRequest(
    "POST",
    "/v1/attestations/finalize",
    { jti: issued.jti, commits: [{ sha: "f".repeat(40) }] },
    { authorization: `Bearer ${issued.finalizeKey}` },
  ));
  assert.equal(response.status, 500);
  const grantRow = await app.storage.DB.prepare(
    "SELECT redeemed_at FROM attestation_grants WHERE jti = ?",
  ).bind(issued.jti).first<{ redeemed_at: string | null }>();
  assert.equal(grantRow?.redeemed_at, null);
});

test("ledger is immutable and retention only deletes audit_logs", async (t) => {
  const { app, key } = await createWorkspaceGrantClient();
  t.after(() => app.close());
  await grant(app, key);
  await app.storage.attestations.appendAttestationLedgerEntry({
    orgId: "org_attestation",
    entryType: "checkpoint",
    payload: { retained: true },
    jws: "test-jws-retention",
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  const row = await app.storage.DB.prepare(
    "SELECT seq, payload_json, prev_hash, entry_hash FROM attestation_ledger LIMIT 1",
  ).first<{ seq: number; payload_json: string; prev_hash: string; entry_hash: string }>();
  assert.ok(row);
  await assert.rejects(
    app.storage.DB.prepare("UPDATE attestation_ledger SET payload_json = ? WHERE seq = ?")
      .bind("{}", row.seq).run(),
  );
  await assert.rejects(
    app.storage.DB.prepare("DELETE FROM attestation_ledger WHERE seq = ?")
      .bind(row.seq).run(),
  );
  const recomputed = crypto.createHash("sha256")
    .update(row.payload_json, "utf8")
    .update(row.prev_hash, "utf8")
    .digest("hex");
  assert.equal(recomputed, row.entry_hash);
  const handTampered = crypto.createHash("sha256")
    .update('{"tampered":true}', "utf8")
    .update(row.prev_hash, "utf8")
    .digest("hex");
  assert.notEqual(handTampered, row.entry_hash, "chain recomputation must detect a hand-tampered payload");

  await app.storage.DB.prepare(`
    INSERT INTO audit_logs (id, action, org_id, result, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    "audit_expired",
    "token.issued",
    "org_attestation",
    "allowed",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
  ).run();
  const sweep = await purgeExpiredEntries(app.storage.DB, 2);
  assert.equal(sweep.deletedCount, 1);
  const ledgerCount = await app.storage.DB.prepare(
    "SELECT COUNT(*) AS count FROM attestation_ledger",
  ).first<{ count: number }>();
  assert.equal(ledgerCount?.count, 2);
});
