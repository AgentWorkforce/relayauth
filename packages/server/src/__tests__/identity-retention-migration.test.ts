import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createNodeSqliteRunner,
  runMigrations,
  sha256,
  type MigrationSource,
} from "@relayauth/migrate";

const MIGRATION_ID = "0011_identity_retention";
const MIGRATION_URL = new URL(
  `../db/migrations/${MIGRATION_ID}.sql`,
  import.meta.url,
);

async function applyMigration(db: DatabaseSync): Promise<void> {
  const sql = await readFile(MIGRATION_URL, "utf8");
  const source: MigrationSource = {
    async list() {
      return [{ id: MIGRATION_ID, sql, checksum: sha256(sql) }];
    },
  };
  const result = await runMigrations(createNodeSqliteRunner(db), source);
  assert.deepEqual(result, { applied: [MIGRATION_ID], skipped: [] });
}

test("upgrading an existing database leaves identity retention off", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());

  await applyMigration(db);

  // The upgrade adds no config rows, and an operator who inserts one without
  // naming `enabled` still gets an organization that is never swept. Turning
  // retention on has to be a deliberate act, not a side effect of a version
  // bump: identity deletion is irreversible.
  assert.deepEqual(
    // node:sqlite returns null-prototype rows; normalize before comparing.
    { ...db.prepare("SELECT COUNT(*) AS count FROM identity_retention_config").get() },
    { count: 0 },
  );

  db.prepare("INSERT INTO identity_retention_config (org_id) VALUES (?)").run("org_new");
  assert.deepEqual(
    db
      .prepare("SELECT org_id, retention_days, enabled FROM identity_retention_config")
      .all()
      .map((row) => ({ ...row })),
    [{ org_id: "org_new", retention_days: 30, enabled: 0 }],
  );
});

test("the capacity sample table holds exactly one row", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());

  await applyMigration(db);

  db.prepare(
    `
      INSERT INTO storage_capacity_samples (id, size_bytes, observed_at)
      VALUES ('current', ?, ?)
    `,
  ).run(5_931_641_856, "2026-09-18T12:00:00.000Z");

  // A second id would let two writers keep divergent gauges and let a reader
  // pick either one.
  assert.throws(
    () =>
      db
        .prepare(
          `
            INSERT INTO storage_capacity_samples (id, size_bytes, observed_at)
            VALUES ('previous', ?, ?)
          `,
        )
        .run(1, "2026-09-18T12:00:00.000Z"),
    /CHECK constraint failed/,
  );

  assert.deepEqual(
    { ...db.prepare("SELECT COUNT(*) AS count FROM storage_capacity_samples").get() },
    { count: 1 },
  );
});

test("the migration is idempotent across reruns", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());

  await applyMigration(db);

  const sql = await readFile(MIGRATION_URL, "utf8");
  const source: MigrationSource = {
    async list() {
      return [{ id: MIGRATION_ID, sql, checksum: sha256(sql) }];
    },
  };
  assert.deepEqual(await runMigrations(createNodeSqliteRunner(db), source), {
    applied: [],
    skipped: [MIGRATION_ID],
  });
});
