import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from "./audit-retention.js";

export type RetentionGcRunMeta = {
  changes?: number;
  duration?: number;
  rows_read?: number;
  rows_written?: number;
  size_after?: number;
};

export type RetentionGcRunResult = {
  deletedCount: number;
  meta?: RetentionGcRunMeta;
};

export type RetentionGcBatchOptions = {
  /** Maximum candidates examined or deleted by this statement. */
  limit?: number;
  /** Stable clock injection for schedulers and tests. */
  now?: Date;
};

export type TokenGcBatchOptions = RetentionGcBatchOptions & {
  /** Keep tokens during the verifier's accepted clock-skew window. */
  expiryGraceSeconds?: number;
};

type SqlRunResult = {
  meta?: RetentionGcRunMeta;
};

type SqlStatement = {
  bind(...params: unknown[]): SqlStatement;
  run(): Promise<SqlRunResult>;
  first<T>(): Promise<T | null>;
};

export type RetentionGcSqlExecutor = {
  prepare(query: string): SqlStatement;
};

const DEFAULT_GC_BATCH_SIZE = 1_000;
const MAX_GC_BATCH_SIZE = 50_000;
const DEFAULT_TOKEN_EXPIRY_GRACE_SECONDS = 60;

// The two branches are disjoint. Default/malformed configs use the global
// created_at index; valid per-org configs use (org_id, created_at). Comparing
// against a YYYY-MM-DD cutoff is deliberately conservative for both SQLite's
// `CURRENT_TIMESTAMP` format and ISO timestamps: rows on the boundary day are
// retained for up to one extra day rather than deleted early.
const AUDIT_RETENTION_CANDIDATES_SQL = `
  SELECT rowid
  FROM (
    SELECT rowid, created_at
    FROM (
      SELECT logs.rowid AS rowid, logs.created_at AS created_at
      FROM audit_logs AS logs
      LEFT JOIN audit_retention_config AS config
        ON config.org_id = logs.org_id
      WHERE (
          config.org_id IS NULL
          OR typeof(config.retention_days) != 'integer'
          OR config.retention_days NOT BETWEEN ? AND ?
        )
        AND logs.created_at < date(?, printf('-%d days', ?))
      ORDER BY logs.created_at ASC, logs.rowid ASC
      LIMIT ?
    )

    UNION ALL

    SELECT rowid, created_at
    FROM (
      SELECT logs.rowid AS rowid, logs.created_at AS created_at
      FROM audit_retention_config AS config
      JOIN audit_logs AS logs
        ON logs.org_id = config.org_id
      WHERE typeof(config.retention_days) = 'integer'
        AND config.retention_days BETWEEN ? AND ?
        AND logs.created_at < date(
          ?,
          printf('-%d days', config.retention_days)
        )
      LIMIT ?
    )
  )
  ORDER BY created_at ASC, rowid ASC
  LIMIT ?
`;

/**
 * Deletes one bounded batch of tokens that can no longer pass verification.
 *
 * Token `expires_at` values are Unix seconds. The default 60-second grace
 * matches the verifier's accepted clock skew, avoiding deletion while a token
 * can still be considered valid.
 */
export async function pruneExpiredTokens(
  db: RetentionGcSqlExecutor,
  options: TokenGcBatchOptions = {},
): Promise<RetentionGcRunResult> {
  const limit = normalizeBatchSize(options.limit);
  const cutoff = createTokenCutoff(options.now, options.expiryGraceSeconds);
  const result = await db
    .prepare(
      `
        DELETE FROM tokens
        WHERE rowid IN (
          SELECT rowid
          FROM tokens
          WHERE expires_at IS NOT NULL
            AND expires_at < ?
          ORDER BY expires_at ASC, rowid ASC
          LIMIT ?
        )
      `,
    )
    .bind(cutoff, limit)
    .run();

  return toGcRunResult(result);
}

/** Returns the number of token candidates in the next bounded batch. */
export async function countExpiredTokensBatch(
  db: RetentionGcSqlExecutor,
  options: TokenGcBatchOptions = {},
): Promise<{ expiredCount: number }> {
  const limit = normalizeBatchSize(options.limit);
  const cutoff = createTokenCutoff(options.now, options.expiryGraceSeconds);
  const row = await db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM (
          SELECT rowid
          FROM tokens
          WHERE expires_at IS NOT NULL
            AND expires_at < ?
          ORDER BY expires_at ASC, rowid ASC
          LIMIT ?
        )
      `,
    )
    .bind(cutoff, limit)
    .first<{ count?: unknown }>();

  return { expiredCount: readCount(row?.count) };
}

/**
 * Deletes one bounded batch of audit logs using each organization's configured
 * retention period, or the 90-day default when the config row is absent.
 */
export async function purgeExpiredEntriesBatch(
  db: RetentionGcSqlExecutor,
  options: RetentionGcBatchOptions = {},
): Promise<RetentionGcRunResult> {
  const limit = normalizeBatchSize(options.limit);
  const now = normalizeNow(options.now).toISOString();
  const result = await db
    .prepare(
      `
        DELETE FROM audit_logs
        WHERE rowid IN (
          ${AUDIT_RETENTION_CANDIDATES_SQL}
        )
      `,
    )
    .bind(
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      now,
      DEFAULT_RETENTION_DAYS,
      limit,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      now,
      limit,
      limit,
    )
    .run();

  return toGcRunResult(result);
}

/** Returns the number of audit candidates in the next bounded batch. */
export async function countExpiredEntriesBatch(
  db: RetentionGcSqlExecutor,
  options: RetentionGcBatchOptions = {},
): Promise<{ expiredCount: number }> {
  const limit = normalizeBatchSize(options.limit);
  const now = normalizeNow(options.now).toISOString();
  const row = await db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM (
          ${AUDIT_RETENTION_CANDIDATES_SQL}
        )
      `,
    )
    .bind(
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      now,
      DEFAULT_RETENTION_DAYS,
      limit,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      now,
      limit,
      limit,
    )
    .first<{ count?: unknown }>();

  return { expiredCount: readCount(row?.count) };
}

export {
  DEFAULT_GC_BATCH_SIZE,
  DEFAULT_TOKEN_EXPIRY_GRACE_SECONDS,
  MAX_GC_BATCH_SIZE,
};

function createTokenCutoff(now: Date | undefined, graceSeconds: number | undefined): number {
  const normalizedGraceSeconds = normalizeGraceSeconds(graceSeconds);
  return Math.floor(normalizeNow(now).getTime() / 1_000) - normalizedGraceSeconds;
}

function normalizeNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  return now;
}

function normalizeGraceSeconds(value: number | undefined): number {
  const graceSeconds = value ?? DEFAULT_TOKEN_EXPIRY_GRACE_SECONDS;
  if (!Number.isInteger(graceSeconds) || graceSeconds < 0) {
    throw new Error("expiryGraceSeconds must be a non-negative integer");
  }
  return graceSeconds;
}

function normalizeBatchSize(value: number | undefined): number {
  const limit = value ?? DEFAULT_GC_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (limit > MAX_GC_BATCH_SIZE) {
    throw new Error(`limit must not exceed ${MAX_GC_BATCH_SIZE}`);
  }
  return limit;
}

function toGcRunResult(result: SqlRunResult): RetentionGcRunResult {
  return {
    deletedCount: readCount(result.meta?.changes),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

function readCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}
