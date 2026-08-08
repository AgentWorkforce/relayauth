import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { purgeExpiredEntries } from "../engine/audit-retention.js";
import { canonicalizeJson } from "../lib/canonical-json.js";
import { signCanonicalRs256 } from "../lib/sign-rs256.js";
import {
  recomputeAttestationLedgerEntryHash,
  type AttestationLedgerSqliteDatabase,
  verifyAttestationLedgerChain,
} from "../storage/attestation-ledger.js";
import type {
  AttestationLedgerEntry,
  AttestationLedgerEntryType,
} from "../storage/interface.js";
import { ATTESTATION_LEDGER_GENESIS_HASH } from "../storage/interface.js";
import {
  appendAttestationLedgerEntryInTransaction,
  createSqliteStorage,
  type SqliteStorage,
} from "../storage/sqlite.js";

const TEST_KEY_PAIR = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
const TEST_PRIVATE_KEY = TEST_KEY_PAIR.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const TEST_PUBLIC_KEY = TEST_KEY_PAIR.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const TEST_KID = "attestation-ledger-test-key";

async function append(
  storage: SqliteStorage,
  orgId: string,
  entryType: AttestationLedgerEntryType,
  payload: Record<string, unknown>,
  createdAt = "2000-01-01T00:00:00.000Z",
): Promise<AttestationLedgerEntry> {
  return storage.attestations.appendAttestationLedgerEntry({
    orgId,
    entryType,
    payload,
    jws: await signCanonicalRs256(payload, TEST_PRIVATE_KEY, TEST_KID),
    createdAt,
  });
}

async function listEntries(storage: SqliteStorage): Promise<AttestationLedgerEntry[]> {
  const result = await storage.DB.prepare(`
    SELECT seq, org_id, org_seq, entry_type, payload_json, jws,
      prev_hash, entry_hash, created_at
    FROM attestation_ledger
    ORDER BY seq ASC
  `).all<Record<string, unknown>>();

  return result.results.map((row) => ({
    seq: Number(row.seq),
    orgId: String(row.org_id),
    orgSeq: Number(row.org_seq),
    entryType: String(row.entry_type) as AttestationLedgerEntryType,
    payloadJson: String(row.payload_json),
    jws: String(row.jws),
    prevHash: String(row.prev_hash),
    entryHash: String(row.entry_hash),
    createdAt: String(row.created_at),
  }));
}

function verifyJws(jws: string): Record<string, unknown> {
  const [header, payload, signature] = jws.split(".");
  assert.ok(header && payload && signature, "expected a compact JWS");
  const protectedHeader = JSON.parse(
    Buffer.from(header, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(protectedHeader.alg, "RS256");
  assert.equal(protectedHeader.kid, TEST_KID);
  assert.equal(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      TEST_PUBLIC_KEY,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("appends N entries across two independently verifiable organization chains", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());

  await append(storage, "org_alpha", "attestation.created", {
    commitSha: "a".repeat(40),
    sessionRef: "session-alpha",
  });
  await append(storage, "org_beta", "identity.created", {
    iat: 1_786_214_400,
    issuer: "https://issuer.example",
    subject: "subject-beta",
  });
  await append(storage, "org_alpha", "key.rotated", { kid: "key-2" });
  await append(storage, "org_beta", "checkpoint", { throughOrgSeq: 1 });
  await append(storage, "org_alpha", "checkpoint", { throughOrgSeq: 2 });

  const entries = await listEntries(storage);
  const alpha = entries.filter((entry) => entry.orgId === "org_alpha");
  const beta = entries.filter((entry) => entry.orgId === "org_beta");
  assert.deepEqual(alpha.map((entry) => entry.orgSeq), [1, 2, 3]);
  assert.deepEqual(beta.map((entry) => entry.orgSeq), [1, 2]);
  assert.equal(alpha[0]?.prevHash, ATTESTATION_LEDGER_GENESIS_HASH);
  assert.equal(beta[0]?.prevHash, ATTESTATION_LEDGER_GENESIS_HASH);
  assert.equal(verifyAttestationLedgerChain(alpha), true);
  assert.equal(verifyAttestationLedgerChain(beta), true);
  for (const entry of entries) {
    assert.deepEqual(verifyJws(entry.jws), JSON.parse(entry.payloadJson));
  }
});

test("ledger schema has no update timestamp, cascade delete, or TTL surface", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());
  // Opening the storage is lazy; force migration initialization.
  await storage.DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();

  const columns = await storage.DB
    .prepare("PRAGMA table_info(attestation_ledger)")
    .all<{ name: string }>();
  const foreignKeys = await storage.DB
    .prepare("PRAGMA foreign_key_list(attestation_ledger)")
    .all<Record<string, unknown>>();
  const schema = await storage.DB
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attestation_ledger'")
    .first<{ sql: string }>();

  assert.equal(columns.results.some((column) => column.name === "updated_at"), false);
  assert.equal(columns.results.some((column) => /expires|ttl/iu.test(column.name)), false);
  assert.deepEqual(foreignKeys.results, []);
  assert.doesNotMatch(schema?.sql ?? "", /ON\s+DELETE\s+CASCADE/iu);
});

test("transaction-scoped append throws without redeeming caller-owned state", async () => {
  const db = new DatabaseSync(":memory:");
  const migrationPath = fileURLToPath(
    new URL("../db/migrations/0009_attestation_ledger.sql", import.meta.url),
  );
  db.exec(readFileSync(migrationPath, "utf8"));
  db.exec(`
    CREATE TABLE test_grants (
      jti TEXT PRIMARY KEY,
      redeemed_at TEXT
    );
    INSERT INTO test_grants (jti, redeemed_at) VALUES ('grant-red', NULL);
    CREATE TRIGGER fail_red_check_append
    BEFORE INSERT ON attestation_ledger
    BEGIN
      SELECT RAISE(ABORT, 'simulated ledger append failure');
    END;
  `);
  const payload = { commitSha: "d".repeat(40), sessionRef: "session-red" };
  const jws = await signCanonicalRs256(payload, TEST_PRIVATE_KEY, TEST_KID);

  db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => {
      appendAttestationLedgerEntryInTransaction(
        db as unknown as AttestationLedgerSqliteDatabase,
        {
          orgId: "org_atomic",
          entryType: "attestation.created",
          payload,
          jws,
          createdAt: "2000-01-01T00:00:00.000Z",
        },
      );
      db.prepare("UPDATE test_grants SET redeemed_at = ? WHERE jti = ?")
        .run("2000-01-01T00:00:00.000Z", "grant-red");
    }, /simulated ledger append failure/u);
  } finally {
    db.exec("ROLLBACK");
  }

  const grant = db.prepare("SELECT redeemed_at FROM test_grants WHERE jti = ?")
    .get("grant-red") as { redeemed_at: string | null };
  const count = db.prepare("SELECT COUNT(*) AS count FROM attestation_ledger")
    .get() as { count: number };
  assert.equal(grant.redeemed_at, null);
  assert.equal(count.count, 0);
  db.close();
});

test("direct SQL UPDATE aborts via the append-only trigger", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());
  const entry = await append(storage, "org_immutable_update", "checkpoint", { retained: true });

  await assert.rejects(
    storage.DB.prepare("UPDATE attestation_ledger SET payload_json = ? WHERE seq = ?")
      .bind("{}", entry.seq)
      .run(),
    /attestation_ledger is append-only/u,
  );
});

test("direct SQL DELETE aborts via the append-only trigger", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());
  const entry = await append(storage, "org_immutable_delete", "checkpoint", { retained: true });

  await assert.rejects(
    storage.DB.prepare("DELETE FROM attestation_ledger WHERE seq = ?")
      .bind(entry.seq)
      .run(),
    /attestation_ledger is append-only/u,
  );
});

test("the audit retention sweep deletes audit_logs and zero ledger rows", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());
  await append(storage, "org_retention", "checkpoint", { retained: true });
  await storage.DB.prepare(`
    INSERT INTO audit_logs (id, action, org_id, result, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    "audit_expired",
    "token.issued",
    "org_retention",
    "allowed",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z",
  ).run();

  const before = await listEntries(storage);
  const sweep = await purgeExpiredEntries(storage.DB, 2);
  const auditCount = await storage.DB
    .prepare("SELECT COUNT(*) AS count FROM audit_logs")
    .first<{ count: number }>();
  const after = await listEntries(storage);

  assert.equal(sweep.deletedCount, 1);
  assert.equal(auditCount?.count, 0);
  assert.deepEqual(after, before);

  const engineDirectory = fileURLToPath(new URL("../engine/", import.meta.url));
  for (const filename of ["audit-retention.ts", "retention-gc.ts"]) {
    assert.doesNotMatch(
      readFileSync(`${engineDirectory}${filename}`, "utf8"),
      /attestation_ledger/u,
      `${filename} must not target the permanent ledger`,
    );
  }
});

test("chain recomputation detects a hand-tampered payload", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());
  await append(storage, "org_tamper", "attestation.created", {
    commitSha: "b".repeat(40),
    sessionRef: "session-original",
  });
  await append(storage, "org_tamper", "checkpoint", { throughOrgSeq: 1 });
  const entries = await listEntries(storage);
  assert.equal(verifyAttestationLedgerChain(entries), true);

  const tampered = entries.map((entry) => ({ ...entry }));
  tampered[0]!.payloadJson = canonicalizeJson({
    commitSha: "c".repeat(40),
    sessionRef: "session-tampered",
  });
  assert.notEqual(
    recomputeAttestationLedgerEntryHash(tampered[0]!),
    tampered[0]!.entryHash,
  );
  assert.equal(verifyAttestationLedgerChain(tampered), false);
});

test("append rejects a non-RS256 JWS without persisting a row", async (t) => {
  const storage = createSqliteStorage(":memory:");
  t.after(() => storage.close());
  const payload = { event: "must-not-append" };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: "bad-key" })).toString("base64url");
  const body = Buffer.from(canonicalizeJson(payload)).toString("base64url");

  await assert.rejects(
    storage.attestations.appendAttestationLedgerEntry({
      orgId: "org_fail_closed",
      entryType: "checkpoint",
      payload,
      jws: `${header}.${body}.invalid`,
    }),
    /RS256/u,
  );
  assert.deepEqual(await listEntries(storage), []);
});
