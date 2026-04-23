import { MigrationChecksumMismatchError, MigrationExecError } from "./errors.js";
import type {
  MigrationRunner,
  MigrationSource,
  RunMigrationsOptions,
  RunMigrationsResult,
} from "./types.js";

/**
 * DDL for the journal table that tracks applied migrations. Runner
 * implementations should execute this (or the equivalent in their dialect)
 * inside their {@link MigrationRunner.initialize} method.
 */
export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);
`.trim();

/**
 * Apply every migration surfaced by {@link MigrationSource} that has not yet
 * been recorded in the journal.
 *
 * Semantics:
 *  1. Calls {@link MigrationRunner.initialize} so the journal table exists.
 *  2. Loads the journal via {@link MigrationRunner.listApplied}.
 *  3. For each file returned by {@link MigrationSource.list}:
 *     - If the journal contains the id and the checksum matches, skip it.
 *     - If the journal contains the id and the checksum differs, throw
 *       {@link MigrationChecksumMismatchError} — the SQL file was edited
 *       after it was applied, which is never safe.
 *     - Otherwise, execute the SQL and record the migration. Errors from
 *       the driver are wrapped in {@link MigrationExecError} so the caller
 *       sees which migration failed.
 *
 * Returns the list of ids that were applied or skipped during this run.
 */
export async function runMigrations(
  runner: MigrationRunner,
  source: MigrationSource,
  opts: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  await runner.initialize();

  const files = await source.list();
  const applied = await runner.listApplied();
  const appliedById = new Map(applied.map((entry) => [entry.id, entry]));

  const appliedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const file of files) {
    const existing = appliedById.get(file.id);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new MigrationChecksumMismatchError(file.id, existing.checksum, file.checksum);
      }
      skippedIds.push(file.id);
      continue;
    }

    opts.onApply?.(file.id);

    try {
      await runner.exec(file.sql);
    } catch (cause) {
      throw new MigrationExecError(file.id, cause);
    }

    await runner.recordApplied({ id: file.id, checksum: file.checksum }, Date.now());
    appliedIds.push(file.id);
  }

  return { applied: appliedIds, skipped: skippedIds };
}
