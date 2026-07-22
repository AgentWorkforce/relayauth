import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  countExpiredEntriesBatch,
  countExpiredTokensBatch,
  MAX_GC_BATCH_SIZE,
  MAX_GC_WINDOW_SIZE,
  pruneExpiredTokens,
  pruneExpiredTokensWindow,
  purgeExpiredEntriesBatch,
  purgeExpiredAuditEntriesWindow,
  scanExpiredAuditEntriesWindow,
  scanExpiredTokensWindow,
  type RetentionGcCursorSqlExecutor,
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
  rowid?: number,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO tokens (rowid, id, identity_id, expires_at, status, created_at)
      VALUES (?, ?, 'identity_test', ?, 'active', ?)
    `,
  )
    .bind(rowid ?? null, id, expiresAt, NOW.toISOString())
    .run();
}

async function insertAuditLog(
  storage: SqliteStorage,
  id: string,
  orgId: string,
  createdAt: string,
  rowid?: number,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO audit_logs (
        rowid, id, action, identity_id, org_id, result, timestamp, created_at
      )
      VALUES (?, ?, 'token.validated', 'identity_test', ?, 'allowed', ?, ?)
    `,
  )
    .bind(rowid ?? null, id, orgId, createdAt, createdAt)
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

function mutateAfterNextWindowScan(
  storage: SqliteStorage,
  table: "tokens" | "audit_logs",
  mutate: () => Promise<void>,
): RetentionGcCursorSqlExecutor {
  let mutated = false;

  return {
    prepare(sql) {
      const prepared = storage.DB.prepare(sql);
      const maybeMutate = async <T>(result: { results?: T[]; meta?: unknown }) => {
        if (!mutated && sql.includes(`SELECT rowid AS rowid FROM ${table}`)) {
          mutated = true;
          await mutate();
        }
        return result;
      };

      return {
        bind(...params: unknown[]) {
          const bound = prepared.bind(...params);
          return {
            bind: () => {
              throw new Error("unexpected second bind");
            },
            all: async <T>() => maybeMutate(await bound.all<T>()),
            run: () => bound.run(),
            first: <T>() => bound.first<T>(),
          };
        },
        all: async <T>() => maybeMutate(await prepared.all<T>()),
        run: () => prepared.run(),
        first: <T>() => prepared.first<T>(),
      };
    },
  };
}

async function readRowidSummary(
  storage: SqliteStorage,
  table: "tokens" | "audit_logs",
): Promise<{ rowCount: number; minRowid: number; maxRowid: number }> {
  const row = await storage.DB.prepare(
    `
      SELECT COUNT(*) AS rowCount, MIN(rowid) AS minRowid, MAX(rowid) AS maxRowid
      FROM ${table}
    `,
  ).first<{ rowCount: number; minRowid: number; maxRowid: number }>();
  assert.ok(row);
  return row;
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

test("token cursor windows skip sparse rowid holes and prune only the closed window", async (t) => {
  const { storage, db } = createStorage(t);
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);

  await insertToken(storage, "tok_expired_first", nowSeconds - 600, 2);
  await insertToken(storage, "tok_live", nowSeconds + 600, 10_000_000);
  await insertToken(storage, "tok_expired_next", nowSeconds - 600, 10_000_001);

  const first = await scanExpiredTokensWindow(db, { cursor: 0, limit: 2, now: NOW });
  assert.deepEqual(
    {
      cursorBefore: first.cursorBefore,
      cursorAfter: first.cursorAfter,
      scannedCount: first.scannedCount,
      expiredCount: first.expiredCount,
      exhausted: first.exhausted,
    },
    {
      cursorBefore: 0,
      cursorAfter: 10_000_000,
      scannedCount: 2,
      expiredCount: 1,
      exhausted: false,
    },
  );

  // This insert gets a higher rowid after the window closed and must not be
  // eligible for deletion from the already-proven range.
  await insertToken(storage, "tok_concurrent", nowSeconds - 600, 10_000_002);
  const pruned = await pruneExpiredTokensWindow(db, first, { now: NOW });
  assert.equal(pruned.deletedCount, 1);
  assert.deepEqual(await readIds(storage, "tokens"), [
    "tok_concurrent",
    "tok_expired_next",
    "tok_live",
  ]);

  const second = await scanExpiredTokensWindow(db, {
    cursor: first.cursorAfter,
    limit: 2,
    now: NOW,
  });
  assert.equal(second.scannedCount, 2);
  assert.equal(second.expiredCount, 2);
  assert.equal(second.exhausted, false);
});

test("audit cursor windows apply config/default retention inside a bounded rowid range", async (t) => {
  const { storage, db } = createStorage(t);
  await storage.DB.prepare(
    "INSERT INTO audit_retention_config (org_id, retention_days) VALUES (?, ?), (?, ?), (?, ?)",
  )
    .bind("org_short", 30, "org_long", 180, "org_invalid", 1)
    .run();

  await insertAuditLog(storage, "aud_default_old", "org_default", daysBeforeNow(100), 3);
  await insertAuditLog(storage, "aud_short_old", "org_short", daysBeforeNow(40), 1_000_000);
  await insertAuditLog(storage, "aud_long_kept", "org_long", daysBeforeNow(100), 1_000_001);
  await insertAuditLog(storage, "aud_invalid_default", "org_invalid", daysBeforeNow(100), 1_000_002);

  const first = await scanExpiredAuditEntriesWindow(db, { cursor: 0, limit: 3, now: NOW });
  assert.equal(first.cursorAfter, 1_000_001);
  assert.equal(first.scannedCount, 3);
  assert.equal(first.expiredCount, 2);
  assert.equal(first.exhausted, false);

  const purged = await purgeExpiredAuditEntriesWindow(db, first, { now: NOW });
  assert.equal(purged.deletedCount, 2);
  assert.deepEqual(await readIds(storage, "audit_logs"), [
    "aud_invalid_default",
    "aud_long_kept",
  ]);

  const second = await scanExpiredAuditEntriesWindow(db, {
    cursor: first.cursorAfter,
    limit: 3,
    now: NOW,
  });
  assert.equal(second.scannedCount, 1);
  assert.equal(second.expiredCount, 1);
  assert.equal(second.exhausted, true);
});

test("token window count and delete stay bounded when SQLite reuses the deleted max rowid", async (t) => {
  const { storage, db } = createStorage(t);
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);

  await insertToken(storage, "tok_original_first", nowSeconds - 600, 1);
  await insertToken(storage, "tok_original_max", nowSeconds - 600, 2_000);

  const racingDb = mutateAfterNextWindowScan(storage, "tokens", async () => {
    await storage.DB.prepare("DELETE FROM tokens WHERE rowid = ?").bind(2_000).run();
    await storage.DB.prepare(
      `
        WITH RECURSIVE seq(n) AS (
          SELECT 2
          UNION ALL
          SELECT n + 1 FROM seq WHERE n < 2000
        )
        INSERT INTO tokens (id, identity_id, expires_at, status, created_at)
        SELECT 'tok_reused_' || n, 'identity_test', ?, 'active', ?
        FROM seq
      `,
    )
      .bind(nowSeconds - 600, NOW.toISOString())
      .run();
  });

  const window = await scanExpiredTokensWindow(racingDb, { cursor: 0, limit: 2, now: NOW });
  assert.deepEqual(await readRowidSummary(storage, "tokens"), {
    rowCount: 2_000,
    minRowid: 1,
    maxRowid: 2_000,
  });

  const pruned = await pruneExpiredTokensWindow(db, window, { now: NOW });
  assert.deepEqual(
    {
      scannedCount: window.scannedCount,
      expiredCount: window.expiredCount,
      deletedCount: pruned.deletedCount,
    },
    {
      scannedCount: 2,
      expiredCount: 2,
      deletedCount: 2,
    },
  );
});

test("audit window count and delete stay bounded when SQLite reuses the deleted max rowid", async (t) => {
  const { storage, db } = createStorage(t);
  const expiredAt = daysBeforeNow(100);

  await insertAuditLog(storage, "aud_original_first", "org_default", expiredAt, 1);
  await insertAuditLog(storage, "aud_original_max", "org_default", expiredAt, 2_000);

  const racingDb = mutateAfterNextWindowScan(storage, "audit_logs", async () => {
    await storage.DB.prepare("DELETE FROM audit_logs WHERE rowid = ?").bind(2_000).run();
    await storage.DB.prepare(
      `
        WITH RECURSIVE seq(n) AS (
          SELECT 2
          UNION ALL
          SELECT n + 1 FROM seq WHERE n < 2000
        )
        INSERT INTO audit_logs (
          id, action, identity_id, org_id, result, timestamp, created_at
        )
        SELECT
          'aud_reused_' || n,
          'token.validated',
          'identity_test',
          'org_default',
          'allowed',
          ?,
          ?
        FROM seq
      `,
    )
      .bind(expiredAt, expiredAt)
      .run();
  });

  const window = await scanExpiredAuditEntriesWindow(racingDb, {
    cursor: 0,
    limit: 2,
    now: NOW,
  });
  assert.deepEqual(await readRowidSummary(storage, "audit_logs"), {
    rowCount: 2_000,
    minRowid: 1,
    maxRowid: 2_000,
  });

  const purged = await purgeExpiredAuditEntriesWindow(db, window, { now: NOW });
  assert.deepEqual(
    {
      scannedCount: window.scannedCount,
      expiredCount: window.expiredCount,
      deletedCount: purged.deletedCount,
    },
    {
      scannedCount: 2,
      expiredCount: 2,
      deletedCount: 2,
    },
  );
});

test("cursor windows report exhaustion without advancing or deleting", async (t) => {
  const { storage, db } = createStorage(t);
  const empty = await scanExpiredTokensWindow(db, { cursor: 42, now: NOW });

  assert.deepEqual(
    {
      cursorBefore: empty.cursorBefore,
      cursorAfter: empty.cursorAfter,
      scannedCount: empty.scannedCount,
      expiredCount: empty.expiredCount,
      exhausted: empty.exhausted,
    },
    {
      cursorBefore: 42,
      cursorAfter: 42,
      scannedCount: 0,
      expiredCount: 0,
      exhausted: true,
    },
  );
  assert.equal((await pruneExpiredTokensWindow(db, empty, { now: NOW })).deletedCount, 0);
  assert.deepEqual(await readIds(storage, "tokens"), []);
});

test("cursor window size is capped at the steady-state 1000-row bound", async (t) => {
  const { db } = createStorage(t);
  await assert.rejects(
    () => scanExpiredTokensWindow(db, { limit: MAX_GC_WINDOW_SIZE + 1 }),
    /must not exceed 1000/,
  );
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

test("audit candidate query plan uses both retention indexes", async (t) => {
  const { storage } = createStorage(t);
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const capturingDb: RetentionGcSqlExecutor = {
    prepare(sql) {
      capturedSql = sql;
      return {
        bind(...params: unknown[]) {
          capturedParams = params;
          const statement = storage.DB.prepare(sql).bind(...params);
          return {
            bind: () => {
              throw new Error("unexpected second bind");
            },
            all: <T>() => statement.all<T>(),
            run: () => statement.run(),
            first: <T>() => statement.first<T>(),
          };
        },
        all: <T>() => storage.DB.prepare(sql).all<T>(),
        run: () => storage.DB.prepare(sql).run(),
        first: <T>() => storage.DB.prepare(sql).first<T>(),
      };
    },
  };

  await countExpiredEntriesBatch(capturingDb, { now: NOW, limit: 1_000 });
  const plan = await storage.DB.prepare(`EXPLAIN QUERY PLAN ${capturedSql}`)
    .bind(...capturedParams)
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join("\n");

  assert.match(details, /idx_audit_logs_created_at/);
  assert.match(details, /idx_audit_logs_org_created_at/);
});

test("cursor queries use rowid range searches without temporary sorting", async (t) => {
  const { storage, db } = createStorage(t);
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  await insertToken(storage, "tok_plan", nowSeconds - 600, 10);
  await insertAuditLog(storage, "aud_plan", "org_default", daysBeforeNow(100), 10);

  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const capturingDb: RetentionGcCursorSqlExecutor = {
    prepare(sql) {
      return {
        bind(...params: unknown[]) {
          captured.push({ sql, params });
          const statement = storage.DB.prepare(sql).bind(...params);
          return {
            bind: () => {
              throw new Error("unexpected second bind");
            },
            all: <T>() => statement.all<T>(),
            run: () => statement.run(),
            first: <T>() => statement.first<T>(),
          };
        },
        all: <T>() => storage.DB.prepare(sql).all<T>(),
        run: () => storage.DB.prepare(sql).run(),
        first: <T>() => storage.DB.prepare(sql).first<T>(),
      };
    },
  };

  const tokenWindow = await scanExpiredTokensWindow(capturingDb, { now: NOW });
  await pruneExpiredTokensWindow(capturingDb, tokenWindow, { now: NOW });
  const auditWindow = await scanExpiredAuditEntriesWindow(capturingDb, { now: NOW });
  await purgeExpiredAuditEntriesWindow(capturingDb, auditWindow, { now: NOW });

  for (const { sql, params } of captured) {
    const plan = await storage.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    if (/\b(tokens|audit_logs)\b/i.test(sql)) {
      assert.doesNotMatch(details, /USE TEMP B-TREE/);
    }
  }

  const tokenDelete = captured.find(({ sql }) => /DELETE FROM tokens/.test(sql));
  const auditDelete = captured.find(({ sql }) => /DELETE FROM audit_logs/.test(sql));
  assert.ok(tokenDelete);
  assert.ok(auditDelete);

  const tokenDeletePlan = await storage.DB.prepare(`EXPLAIN QUERY PLAN ${tokenDelete.sql}`)
    .bind(...tokenDelete.params)
    .all<{ detail: string }>();
  assert.match(tokenDeletePlan.results.map(({ detail }) => detail).join("\n"), /INTEGER PRIMARY KEY/);

  const auditDeletePlan = await storage.DB.prepare(`EXPLAIN QUERY PLAN ${auditDelete.sql}`)
    .bind(...auditDelete.params)
    .all<{ detail: string }>();
  assert.match(auditDeletePlan.results.map(({ detail }) => detail).join("\n"), /INTEGER PRIMARY KEY/);
});
