import { MIGRATIONS_TABLE_SQL } from "../runner.js";
import type { AppliedMigration, MigrationRunner } from "../types.js";

/**
 * Minimal structural type for a Cloudflare D1 prepared statement. We declare
 * only the surface we use so consumers don't have to depend on
 * `@cloudflare/workers-types` for the sake of satisfying this runner.
 */
export interface D1PreparedStatementLike<Row = unknown> {
  bind(...values: unknown[]): D1PreparedStatementLike<Row>;
  run(): Promise<D1ResultLike<Row>>;
  all(): Promise<D1ResultLike<Row>>;
  first<T = Row>(colName?: string): Promise<T | null>;
}

export interface D1ResultLike<Row = unknown> {
  results?: Row[];
  success?: boolean;
  meta?: unknown;
}

export interface D1DatabaseLike {
  prepare<Row = unknown>(sql: string): D1PreparedStatementLike<Row>;
  batch<Row = unknown>(statements: D1PreparedStatementLike<Row>[]): Promise<D1ResultLike<Row>[]>;
}

/**
 * Build a {@link MigrationRunner} backed by Cloudflare D1 (or any other
 * driver that matches the D1 prepared-statement surface).
 *
 * Atomicity: a migration file is split on unquoted semicolons (see
 * {@link splitSqlStatements}) into individual statements, which are then
 * submitted to D1 via `db.batch(...)`. D1 batches run inside a single
 * transaction on the Cloudflare side — if any statement fails, the whole
 * migration rolls back, so partially-applied DDL is impossible.
 *
 * Caveat: the statement splitter is deliberately naive — it strips
 * `--`-prefixed line comments and splits on `;`. Migrations that embed
 * semicolons inside string literals or BEGIN/END blocks are not supported
 * today; use a dedicated migration file per such statement until the
 * splitter grows a tokenizer.
 */
export function createD1Runner(db: D1DatabaseLike): MigrationRunner {
  return {
    async initialize() {
      await db.prepare(MIGRATIONS_TABLE_SQL).run();
    },

    async exec(sql) {
      const statements = splitSqlStatements(sql);
      if (statements.length === 0) {
        return;
      }

      if (statements.length === 1) {
        await db.prepare(statements[0]).run();
        return;
      }

      await db.batch(statements.map((stmt) => db.prepare(stmt)));
    },

    async listApplied() {
      const result = await db
        .prepare<{ id: string; applied_at: number; checksum: string }>(
          "SELECT id, applied_at, checksum FROM _migrations ORDER BY id ASC",
        )
        .all();

      return (result.results ?? []).map<AppliedMigration>((row) => ({
        id: row.id,
        appliedAt: Number(row.applied_at),
        checksum: row.checksum,
      }));
    },

    async recordApplied(file, appliedAt) {
      await db
        .prepare("INSERT OR IGNORE INTO _migrations (id, applied_at, checksum) VALUES (?, ?, ?)")
        .bind(file.id, appliedAt, file.checksum)
        .run();
    },
  };
}

/**
 * Strip `--`-prefixed line comments and split the remaining SQL on `;`,
 * returning one trimmed statement per element with empty entries dropped.
 *
 * Exported for the test suite — consumers should call {@link createD1Runner}
 * rather than invoking the splitter directly.
 */
export function splitSqlStatements(sql: string): string[] {
  const stripped = sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  return stripped
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}
