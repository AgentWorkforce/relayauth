/**
 * Thrown when a migration already recorded in the journal has different SQL
 * contents (checksum mismatch) than when it was applied. This indicates a
 * developer edited a migration file after it shipped, which is never safe.
 */
export class MigrationChecksumMismatchError extends Error {
  readonly id: string;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;

  constructor(id: string, expectedChecksum: string, actualChecksum: string) {
    super(
      `migration ${id} sql changed since applied; content drift detected ` +
        `(expected checksum ${expectedChecksum}, got ${actualChecksum}). ` +
        `Edit a new migration file instead of modifying an applied one.`,
    );
    this.name = "MigrationChecksumMismatchError";
    this.id = id;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

/**
 * Wraps a driver-level error thrown while executing a migration's SQL so the
 * caller can see which migration failed without losing the underlying cause.
 */
export class MigrationExecError extends Error {
  readonly id: string;

  constructor(id: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`migration ${id} failed: ${message}`);
    this.name = "MigrationExecError";
    this.id = id;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}
