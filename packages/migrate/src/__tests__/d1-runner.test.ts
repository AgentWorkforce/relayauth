import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MigrationChecksumMismatchError,
  createD1Runner,
  createFsMigrationSource,
  runMigrations,
  sha256,
  splitSqlStatements,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from "../index.js";

/**
 * Wrap node:sqlite's synchronous DatabaseSync behind the async D1 prepared-
 * statement surface so the D1 runner can be exercised without a real
 * Cloudflare binding.
 *
 * The goal is not to emulate D1 perfectly; it's to exercise the runner's
 * prepare/batch/run/all/first call patterns against a real SQL engine.
 */
function createFakeD1(db: DatabaseSync): D1DatabaseLike {
  function prepare<Row = unknown>(sql: string): D1PreparedStatementLike<Row> {
    let boundParams: unknown[] = [];
    const api: D1PreparedStatementLike<Row> = {
      bind(...values: unknown[]) {
        boundParams = values;
        return api;
      },
      async run(): Promise<D1ResultLike<Row>> {
        db.prepare(sql).run(...(boundParams as unknown[]));
        return { success: true };
      },
      async all(): Promise<D1ResultLike<Row>> {
        const rows = db.prepare(sql).all(...(boundParams as unknown[])) as Row[];
        return { results: rows, success: true };
      },
      async first<T = Row>(): Promise<T | null> {
        const row = db.prepare(sql).get(...(boundParams as unknown[])) as T | undefined;
        return row ?? null;
      },
    };
    return api;
  }

  return {
    prepare,
    async batch<Row = unknown>(
      statements: D1PreparedStatementLike<Row>[],
    ): Promise<D1ResultLike<Row>[]> {
      const results: D1ResultLike<Row>[] = [];
      db.exec("BEGIN");
      try {
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // swallow — caller needs the original error
        }
        throw err;
      }
      return results;
    },
  };
}

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relayauth-migrate-d1-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, "utf8");
}

test("fresh DB: all files apply and journal is populated", async () => {
  const { dir, cleanup } = createTempDir();
  const db = new DatabaseSync(":memory:");
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");
    writeMigration(dir, "0002_posts.sql", "CREATE TABLE posts (id TEXT PRIMARY KEY);");

    const runner = createD1Runner(createFakeD1(db));
    const source = createFsMigrationSource(dir);

    const result = await runMigrations(runner, source);

    assert.deepEqual(result.applied, ["0001_users", "0002_posts"]);
    assert.deepEqual(result.skipped, []);

    const applied = await runner.listApplied();
    assert.equal(applied.length, 2);
    assert.equal(applied[0]?.id, "0001_users");
    assert.equal(applied[0]?.checksum, sha256("CREATE TABLE users (id TEXT PRIMARY KEY);"));

    db.exec("INSERT INTO users (id) VALUES ('u1')");
    db.exec("INSERT INTO posts (id) VALUES ('p1')");
  } finally {
    db.close();
    cleanup();
  }
});

test("rerun: nothing applies again, skipped equals all", async () => {
  const { dir, cleanup } = createTempDir();
  const db = new DatabaseSync(":memory:");
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");

    const runner = createD1Runner(createFakeD1(db));
    const source = createFsMigrationSource(dir);

    await runMigrations(runner, source);
    const second = await runMigrations(runner, source);

    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ["0001_users"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("checksum drift throws MigrationChecksumMismatchError", async () => {
  const { dir, cleanup } = createTempDir();
  const db = new DatabaseSync(":memory:");
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");

    const runner = createD1Runner(createFakeD1(db));
    await runMigrations(runner, createFsMigrationSource(dir));

    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);");

    await assert.rejects(
      () => runMigrations(runner, createFsMigrationSource(dir)),
      (err: unknown) => err instanceof MigrationChecksumMismatchError,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("multi-statement migration is batched atomically — failure rolls back prior statements", async () => {
  const { dir, cleanup } = createTempDir();
  const db = new DatabaseSync(":memory:");
  try {
    // Second statement is invalid (missing table). The batch must roll back
    // the first so `users` doesn't exist after the failed migration.
    writeMigration(
      dir,
      "0001_broken.sql",
      `CREATE TABLE users (id TEXT PRIMARY KEY);
       INSERT INTO nonexistent (id) VALUES ('x');`,
    );

    const runner = createD1Runner(createFakeD1(db));
    const source = createFsMigrationSource(dir);

    await assert.rejects(() => runMigrations(runner, source));

    // Prior statement must not have survived the failed batch.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .all();
    assert.equal(tables.length, 0);

    // Journal must not record the failed migration.
    const applied = await runner.listApplied();
    assert.equal(applied.length, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("splitSqlStatements strips -- comments and splits on unquoted semicolons", () => {
  const sql = `
    -- header comment
    CREATE TABLE a (id TEXT); -- inline comment
    CREATE INDEX idx_a ON a (id);
  `;
  assert.deepEqual(splitSqlStatements(sql), [
    "CREATE TABLE a (id TEXT)",
    "CREATE INDEX idx_a ON a (id)",
  ]);
});

test("recordApplied is idempotent on duplicate ids", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const runner = createD1Runner(createFakeD1(db));
    await runner.initialize();

    await runner.recordApplied({ id: "0001_x", checksum: "abc" }, 1);
    await runner.recordApplied({ id: "0001_x", checksum: "def" }, 2);

    const applied = await runner.listApplied();
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.checksum, "abc"); // first wins; INSERT OR IGNORE
  } finally {
    db.close();
  }
});
