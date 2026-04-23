/**
 * A migration file as surfaced by a {@link MigrationSource}.
 *
 * Sources are responsible for loading the raw SQL and computing the sha256
 * checksum of the SQL contents so the migrator can detect content drift on
 * subsequent runs.
 */
export type MigrationFile = {
  /** Stable identifier for the migration, e.g. `0001_local_bootstrap`. */
  id: string;
  /** Full SQL contents of the migration file. */
  sql: string;
  /** 64-char lowercase sha256 hex digest of {@link MigrationFile.sql}. */
  checksum: string;
};

/**
 * A record as stored in the `_migrations` journal table.
 */
export type AppliedMigration = {
  id: string;
  appliedAt: number;
  checksum: string;
};

/**
 * Adapter-agnostic interface for executing migrations against a database.
 *
 * Implementations live in this package (node-sqlite) or consumers (D1). The
 * interface intentionally uses `Promise` everywhere so a single
 * {@link runMigrations} orchestrator can drive both synchronous (better-
 * sqlite3 / node:sqlite) and asynchronous (Cloudflare D1) backends.
 */
export interface MigrationRunner {
  /**
   * Create the `_migrations` journal table if it does not already exist.
   *
   * Called once at the start of {@link runMigrations} before any other method.
   */
  initialize(): Promise<void>;

  /**
   * Execute one or more SQL statements. Callers pass an entire migration
   * file's contents as a single string.
   *
   * Implementations MUST run the SQL inside a transaction when the underlying
   * driver supports one so a failed migration does not leave partial tables
   * behind. Drivers that do not support transactions (e.g. D1 in some
   * configurations) should document the caveat and best-effort rollback.
   */
  exec(sql: string): Promise<void>;

  /**
   * Return the list of migration IDs already applied, in lex-ascending order,
   * along with the checksum recorded when they were applied.
   */
  listApplied(): Promise<AppliedMigration[]>;

  /**
   * Record a migration as successfully applied.
   *
   * Called by {@link runMigrations} after {@link MigrationRunner.exec}
   * resolves. Implementations SHOULD make this idempotent (INSERT OR IGNORE /
   * ON CONFLICT DO NOTHING) so a partial-write crash between `exec` and
   * `recordApplied` can be recovered by re-running.
   */
  recordApplied(file: { id: string; checksum: string }, appliedAt: number): Promise<void>;
}

/**
 * Platform-specific loader for migration files.
 *
 * Implementations:
 *  - `createFsMigrationSource(dir)` — reads `dir/*.sql` via `fs/promises`.
 *  - Consumers on Cloudflare Workers will provide their own implementation
 *    that uses `import.meta.glob` or bundled string constants since Workers
 *    have no filesystem.
 */
export interface MigrationSource {
  /**
   * Return the set of available migration files, sorted by ID lex-ascending.
   */
  list(): Promise<MigrationFile[]>;
}

export type RunMigrationsOptions = {
  /**
   * Invoked once per migration as it is about to be applied. Useful for
   * surfacing progress to a CLI or log stream.
   */
  onApply?: (id: string) => void;
};

export type RunMigrationsResult = {
  /** IDs that were applied during this run, in order. */
  applied: string[];
  /** IDs that were skipped (already applied and checksum matched). */
  skipped: string[];
};
