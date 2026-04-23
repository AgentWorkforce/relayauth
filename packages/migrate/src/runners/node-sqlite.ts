import { MIGRATIONS_TABLE_SQL } from "../runner.js";
import type { AppliedMigration, MigrationRunner } from "../types.js";

/**
 * Minimal row shape returned by prepared statements. Kept permissive so we
 * accept both better-sqlite3 and node:sqlite shapes.
 */
type SqliteRow = Record<string, unknown>;

interface SqliteStatement<Row extends SqliteRow = SqliteRow> {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

/**
 * Structural type satisfied by both better-sqlite3 `Database` instances and
 * the adapter that `@relayauth/server` builds around `node:sqlite.DatabaseSync`.
 *
 * We deliberately do NOT depend on better-sqlite3 types here; consumers pass
 * any database that exposes this synchronous surface.
 */
export interface NodeSqliteDatabase {
  exec(sql: string): unknown;
  prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row>;
}

/**
 * Build a {@link MigrationRunner} backed by a synchronous Node SQLite driver
 * (better-sqlite3 or node:sqlite via an adapter).
 *
 * Each migration runs inside a `BEGIN`/`COMMIT` transaction so a failure
 * rolls back the partial DDL. The `_migrations` insert also participates in
 * the transaction, so crashes between exec and recordApplied are impossible.
 */
export function createNodeSqliteRunner(db: NodeSqliteDatabase): MigrationRunner {
  return {
    async initialize() {
      db.exec(MIGRATIONS_TABLE_SQL);
    },

    async exec(sql) {
      db.exec("BEGIN");
      try {
        db.exec(sql);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // If rollback itself throws (e.g. no tx in flight because the
          // driver auto-committed a DDL statement), swallow — the original
          // error is what the caller needs to see.
        }
        throw err;
      }
    },

    async listApplied() {
      const rows = db
        .prepare<{ id: string; applied_at: number; checksum: string }>(
          "SELECT id, applied_at, checksum FROM _migrations ORDER BY id ASC",
        )
        .all();

      return rows.map<AppliedMigration>((row) => ({
        id: row.id,
        appliedAt: Number(row.applied_at),
        checksum: row.checksum,
      }));
    },

    async recordApplied(file, appliedAt) {
      db.prepare(
        "INSERT OR IGNORE INTO _migrations (id, applied_at, checksum) VALUES (?, ?, ?)",
      ).run(file.id, appliedAt, file.checksum);
    },
  };
}
