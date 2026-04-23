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
 * Split a SQL migration into individual statements.
 *
 * Walks the input character-by-character tracking whether the cursor is
 * inside a single-quoted string (`'...'` with `''` as the SQL standard
 * escape), a double-quoted identifier (`"..."` with `""` as escape), or an
 * ordinary region. Outside strings, `--` begins a line comment that runs
 * to the next newline, and `;` terminates a statement. Inside a string or
 * identifier those characters are literal.
 *
 * Not supported (migrations that need these should fail loudly during
 * review rather than silently corrupt at runtime):
 *   - `/* ... *` `/` block comments — not used by relayauth migrations today.
 *   - Backslash escapes inside strings — SQLite doesn't honor them.
 *
 * Exported for the test suite — consumers should call {@link createD1Runner}
 * rather than invoking the splitter directly.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let mode: "normal" | "single" | "double" | "line-comment" = "normal";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (mode === "line-comment") {
      if (ch === "\n") {
        mode = "normal";
        current += ch;
      }
      continue;
    }

    if (mode === "single") {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          // Escaped quote — consume both and stay inside the string.
          current += next;
          i++;
        } else {
          mode = "normal";
        }
      }
      continue;
    }

    if (mode === "double") {
      current += ch;
      if (ch === '"') {
        if (next === '"') {
          current += next;
          i++;
        } else {
          mode = "normal";
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      mode = "line-comment";
      i++;
      continue;
    }

    if (ch === "'") {
      mode = "single";
      current += ch;
      continue;
    }

    if (ch === '"') {
      mode = "double";
      current += ch;
      continue;
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
}
