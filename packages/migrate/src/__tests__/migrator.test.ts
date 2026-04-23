import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MigrationChecksumMismatchError,
  MigrationExecError,
  createFsMigrationSource,
  createNodeSqliteRunner,
  runMigrations,
  sha256,
  type NodeSqliteDatabase,
} from "../index.js";

/**
 * node:sqlite's DatabaseSync implements exec() but its prepare() returns a
 * statement whose .all() returns rows as plain objects — compatible with the
 * NodeSqliteDatabase contract.
 */
function openMemoryDb(): NodeSqliteDatabase & { close(): void } {
  const db = new DatabaseSync(":memory:");
  return db as unknown as NodeSqliteDatabase & { close(): void };
}

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relayauth-migrate-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, "utf8");
}

test("fresh DB: all files apply and journal is populated", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");
    writeMigration(dir, "0002_posts.sql", "CREATE TABLE posts (id TEXT PRIMARY KEY);");

    const runner = createNodeSqliteRunner(db);
    const source = createFsMigrationSource(dir);

    const seen: string[] = [];
    const result = await runMigrations(runner, source, { onApply: (id) => seen.push(id) });

    assert.deepEqual(result.applied, ["0001_users", "0002_posts"]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(seen, ["0001_users", "0002_posts"]);

    const applied = await runner.listApplied();
    assert.equal(applied.length, 2);
    assert.equal(applied[0]?.id, "0001_users");
    assert.equal(applied[1]?.id, "0002_posts");
    assert.equal(applied[0]?.checksum.length, 64);
    assert.equal(applied[0]?.checksum, sha256("CREATE TABLE users (id TEXT PRIMARY KEY);"));

    // Sanity: tables actually exist.
    db.exec("INSERT INTO users (id) VALUES ('u1')");
    db.exec("INSERT INTO posts (id) VALUES ('p1')");
  } finally {
    db.close();
    cleanup();
  }
});

test("rerun: nothing applies again, skipped equals all", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");

    const runner = createNodeSqliteRunner(db);
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

test("new migration added: only the new one applies", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");

    const runner = createNodeSqliteRunner(db);
    const source = createFsMigrationSource(dir);

    await runMigrations(runner, source);

    writeMigration(dir, "0002_posts.sql", "CREATE TABLE posts (id TEXT PRIMARY KEY);");
    const second = await runMigrations(runner, source);

    assert.deepEqual(second.applied, ["0002_posts"]);
    assert.deepEqual(second.skipped, ["0001_users"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("checksum mismatch: throws with clear error, no changes applied", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");

    const runner = createNodeSqliteRunner(db);
    const source = createFsMigrationSource(dir);

    await runMigrations(runner, source);

    // Edit the file after it has been applied — this is the drift scenario.
    writeMigration(
      dir,
      "0001_users.sql",
      "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);",
    );

    await assert.rejects(
      () => runMigrations(runner, source),
      (err: unknown) => {
        assert.ok(err instanceof MigrationChecksumMismatchError, "expected checksum mismatch error");
        assert.equal((err as MigrationChecksumMismatchError).id, "0001_users");
        assert.match((err as Error).message, /content drift detected/);
        return true;
      },
    );

    // Journal unchanged: still one entry with the original checksum.
    const applied = await runner.listApplied();
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.id, "0001_users");
  } finally {
    db.close();
    cleanup();
  }
});

test("empty directory: runMigrations is a no-op", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    const runner = createNodeSqliteRunner(db);
    const source = createFsMigrationSource(dir);

    const result = await runMigrations(runner, source);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, []);

    // The journal table should still have been created by initialize().
    const applied = await runner.listApplied();
    assert.deepEqual(applied, []);
  } finally {
    db.close();
    cleanup();
  }
});

test("nonexistent directory: source.list returns empty, no throw", async () => {
  const db = openMemoryDb();
  try {
    const runner = createNodeSqliteRunner(db);
    const source = createFsMigrationSource("/tmp/relayauth-does-not-exist-xyz-123");
    const result = await runMigrations(runner, source);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, []);
  } finally {
    db.close();
  }
});

test("malformed file (invalid SQL): throws and no partial journal entry", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");
    writeMigration(dir, "0002_broken.sql", "THIS IS NOT VALID SQL;");

    const runner = createNodeSqliteRunner(db);
    const source = createFsMigrationSource(dir);

    await assert.rejects(
      () => runMigrations(runner, source),
      (err: unknown) => {
        assert.ok(err instanceof MigrationExecError, "expected exec error");
        assert.equal((err as MigrationExecError).id, "0002_broken");
        return true;
      },
    );

    // The first migration should still be recorded, the broken one should NOT
    // have a journal entry.
    const applied = await runner.listApplied();
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.id, "0001_users");
  } finally {
    db.close();
    cleanup();
  }
});

test("non-sql files are ignored", async () => {
  const { dir, cleanup } = createTempDir();
  const db = openMemoryDb();
  try {
    writeMigration(dir, "README.md", "# Migrations");
    writeMigration(dir, "0001_users.sql", "CREATE TABLE users (id TEXT PRIMARY KEY);");

    const source = createFsMigrationSource(dir);
    const files = await source.list();
    assert.equal(files.length, 1);
    assert.equal(files[0]?.id, "0001_users");

    const runner = createNodeSqliteRunner(db);
    const result = await runMigrations(runner, source);
    assert.deepEqual(result.applied, ["0001_users"]);
  } finally {
    db.close();
    cleanup();
  }
});
