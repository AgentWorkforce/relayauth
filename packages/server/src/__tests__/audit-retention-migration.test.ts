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

const MIGRATION_ID = "0006_audit_retention_default";
const MIGRATION_URL = new URL(
  `../db/migrations/${MIGRATION_ID}.sql`,
  import.meta.url,
);

test("audit retention default migration preserves explicit overrides", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());

  db.exec(`
    CREATE TABLE audit_retention_config (
      org_id TEXT PRIMARY KEY,
      retention_days INTEGER NOT NULL DEFAULT 90
    );
    INSERT INTO audit_retention_config (org_id, retention_days)
    VALUES ('org_override', 30);
  `);

  const sql = await readFile(MIGRATION_URL, "utf8");
  const source: MigrationSource = {
    async list() {
      return [{ id: MIGRATION_ID, sql, checksum: sha256(sql) }];
    },
  };
  const result = await runMigrations(createNodeSqliteRunner(db), source);

  assert.deepEqual(result, { applied: [MIGRATION_ID], skipped: [] });
  assert.deepEqual(
    db
      .prepare(
        "SELECT org_id, retention_days FROM audit_retention_config ORDER BY org_id",
      )
      .all()
      .map((row) => ({
        org_id: row.org_id,
        retention_days: row.retention_days,
      })),
    [{ org_id: "org_override", retention_days: 30 }],
  );

  db.prepare("INSERT INTO audit_retention_config (org_id) VALUES (?)").run(
    "org_default",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT org_id, retention_days FROM audit_retention_config ORDER BY org_id",
      )
      .all()
      .map((row) => ({
        org_id: row.org_id,
        retention_days: row.retention_days,
      })),
    [
      { org_id: "org_default", retention_days: 2 },
      { org_id: "org_override", retention_days: 30 },
    ],
  );
});
