import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  countExpiredEntriesBatch,
  countExpiredTokensBatch,
  MAX_GC_BATCH_SIZE,
  pruneExpiredTokens,
  purgeExpiredEntriesBatch,
  type RetentionGcSqlExecutor,
} from "../engine/retention-gc.js";
import { createSqliteStorage, type SqliteStorage } from "../storage/sqlite.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function createStorage(t: TestContext): {
  storage: SqliteStorage;
  db: RetentionGcSqlExecutor;
} {
  const storage = createSqliteStorage(":memory:");
  t.after(async () => storage.close());
  return {
    storage,
    db: storage.DB as unknown as RetentionGcSqlExecutor,
  };
}

async function insertToken(
  storage: SqliteStorage,
  id: string,
  expiresAt: number | null,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO tokens (id, identity_id, expires_at, status, created_at)
      VALUES (?, 'identity_test', ?, 'active', ?)
    `,
  )
    .bind(id, expiresAt, NOW.toISOString())
    .run();
}

async function insertAuditLog(
  storage: SqliteStorage,
  id: string,
  orgId: string,
  createdAt: string,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO audit_logs (
        id, action, identity_id, org_id, result, timestamp, created_at
      )
      VALUES (?, 'token.validated', 'identity_test', ?, 'allowed', ?, ?)
    `,
  )
    .bind(id, orgId, createdAt, createdAt)
    .run();
}

function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

async function readIds(storage: SqliteStorage, table: "tokens" | "audit_logs"): Promise<string[]> {
  const result = await storage.DB.prepare(`SELECT id FROM ${table} ORDER BY id ASC`).all<{
    id: string;
  }>();
  return result.results.map((row) => row.id);
}

test("pruneExpiredTokens bounds a batch and preserves verifier clock skew", async (t) => {
  const { storage, db } = createStorage(t);
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);

  await insertToken(storage, "tok_oldest", nowSeconds - 600);
  await insertToken(storage, "tok_old", nowSeconds - 120);
  await insertToken(storage, "tok_grace_boundary", nowSeconds - 60);
  await insertToken(storage, "tok_recently_expired", nowSeconds - 1);
  await insertToken(storage, "tok_no_expiry", null);

  assert.deepEqual(await countExpiredTokensBatch(db, { now: NOW, limit: 1 }), {
    expiredCount: 1,
  });

  const firstBatch = await pruneExpiredTokens(db, { now: NOW, limit: 1 });
  assert.equal(firstBatch.deletedCount, 1);
  assert.deepEqual(await readIds(storage, "tokens"), [
    "tok_grace_boundary",
    "tok_no_expiry",
    "tok_old",
    "tok_recently_expired",
  ]);

  const secondBatch = await pruneExpiredTokens(db, { now: NOW, limit: 1 });
  assert.equal(secondBatch.deletedCount, 1);
  assert.deepEqual(await readIds(storage, "tokens"), [
    "tok_grace_boundary",
    "tok_no_expiry",
    "tok_recently_expired",
  ]);
});

test("audit retention uses overrides, a 90-day default, and bounded batches", async (t) => {
  const { storage, db } = createStorage(t);

  await storage.DB.prepare(
    "INSERT INTO audit_retention_config (org_id, retention_days) VALUES (?, ?), (?, ?), (?, ?), (?, ?)",
  )
    .bind("org_short", 30, "org_long", 180, "org_invalid", 1, "org_fractional", 30.5)
    .run();

  await insertAuditLog(storage, "aud_default_old", "org_default", daysBeforeNow(100));
  await insertAuditLog(storage, "aud_default_recent", "org_default", daysBeforeNow(80));
  await insertAuditLog(storage, "aud_short_old", "org_short", daysBeforeNow(40));
  await insertAuditLog(storage, "aud_short_recent", "org_short", daysBeforeNow(20));
  await insertAuditLog(storage, "aud_long_recent", "org_long", daysBeforeNow(100));
  await insertAuditLog(storage, "aud_invalid_old", "org_invalid", daysBeforeNow(100));
  await insertAuditLog(storage, "aud_fractional_recent", "org_fractional", daysBeforeNow(40));

  assert.deepEqual(await countExpiredEntriesBatch(db, { now: NOW, limit: 2 }), {
    expiredCount: 2,
  });

  const firstBatch = await purgeExpiredEntriesBatch(db, { now: NOW, limit: 2 });
  assert.equal(firstBatch.deletedCount, 2);

  const secondBatch = await purgeExpiredEntriesBatch(db, { now: NOW, limit: 2 });
  assert.equal(secondBatch.deletedCount, 1);
  assert.deepEqual(await readIds(storage, "audit_logs"), [
    "aud_default_recent",
    "aud_fractional_recent",
    "aud_long_recent",
    "aud_short_recent",
  ]);
});

test("bounded counts do not delete rows", async (t) => {
  const { storage, db } = createStorage(t);
  await insertAuditLog(storage, "aud_old", "org_default", daysBeforeNow(100));

  assert.equal((await countExpiredEntriesBatch(db, { now: NOW })).expiredCount, 1);
  assert.deepEqual(await readIds(storage, "audit_logs"), ["aud_old"]);
});

test("batch size refuses statements above the emergency-tested ceiling", async (t) => {
  const { db } = createStorage(t);
  await assert.rejects(
    () => pruneExpiredTokens(db, { now: NOW, limit: MAX_GC_BATCH_SIZE + 1 }),
    /must not exceed 50000/,
  );
});

test("bootstrap installs the retention query indexes", async (t) => {
  const { storage } = createStorage(t);
  const result = await storage.DB.prepare(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_tokens_expires_at',
          'idx_audit_logs_created_at',
          'idx_audit_logs_org_created_at'
        )
      ORDER BY name ASC
    `,
  ).all<{ name: string }>();

  assert.deepEqual(
    result.results.map((row) => row.name),
    [
      "idx_audit_logs_created_at",
      "idx_audit_logs_org_created_at",
      "idx_tokens_expires_at",
    ],
  );
});
