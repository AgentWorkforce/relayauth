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

export type RetentionGcWindowOptions = RetentionGcBatchOptions & {
  /** Last rowid completed by the previous window. Defaults to the sweep origin. */
  cursor?: number;
};

export type TokenGcWindowOptions = RetentionGcWindowOptions & {
  /** Keep tokens during the verifier's accepted clock-skew window. */
  expiryGraceSeconds?: number;
};

export type RetentionGcWindow = {
  cursorBefore: number;
  cursorAfter: number;
  scannedCount: number;
  exhausted: boolean;
};

export type RetentionGcWindowScanResult = RetentionGcWindow & {
  expiredCount: number;
  /** D1 query metadata for the bounded rowid scan, when supplied by the executor. */
  meta?: RetentionGcRunMeta;
};

type SqlRunResult = {
  meta?: RetentionGcRunMeta;
};

type SqlAllResult<T> = {
  results?: T[];
  meta?: RetentionGcRunMeta;
};

type SqlStatement = {
  bind(...params: unknown[]): SqlStatement;
  run(): Promise<SqlRunResult>;
  first<T>(): Promise<T | null>;
};

type SqlCursorStatement = {
  bind(...params: unknown[]): SqlCursorStatement;
  all<T>(): Promise<SqlAllResult<T>>;
  run(): Promise<SqlRunResult>;
  first<T>(): Promise<T | null>;
};

export type RetentionGcSqlExecutor = {
  prepare(query: string): SqlStatement;
};

export type RetentionGcCursorSqlExecutor = {
  prepare(query: string): SqlCursorStatement;
};

const DEFAULT_GC_BATCH_SIZE = 1_000;
const MAX_GC_BATCH_SIZE = 50_000;
const MAX_GC_WINDOW_SIZE = 1_000;
const DEFAULT_TOKEN_EXPIRY_GRACE_SECONDS = 60;

const AUDIT_RETENTION_WINDOW_COUNT_SQL = `
  SELECT COUNT(*) AS count
  FROM audit_logs AS logs
  LEFT JOIN audit_retention_config AS config
    ON config.org_id = logs.org_id
  WHERE logs.rowid > ?
    AND logs.rowid <= ?
    AND logs.created_at < date(
      ?,
      printf(
        '-%d days',
        CASE
          WHEN typeof(config.retention_days) = 'integer'
            AND config.retention_days BETWEEN ? AND ?
          THEN config.retention_days
          ELSE ?
        END
      )
    )
`;

const AUDIT_RETENTION_WINDOW_DELETE_SQL = `
  DELETE FROM audit_logs
  WHERE rowid > ?
    AND rowid <= ?
    AND created_at < date(
      ?,
      printf(
        '-%d days',
        COALESCE(
          (
            SELECT CASE
              WHEN typeof(config.retention_days) = 'integer'
                AND config.retention_days BETWEEN ? AND ?
              THEN config.retention_days
              ELSE NULL
            END
            FROM audit_retention_config AS config
            WHERE config.org_id = audit_logs.org_id
          ),
          ?
        )
      )
    )
`;

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
 * Examines the next bounded set of existing token rows in intrinsic rowid
 * order, then counts expired tokens only inside that closed range.
 *
 * The first statement is a rowid B-tree range seek. It efficiently crosses
 * sparse rowid gaps without evaluating expiry predicates outside the returned
 * window. Once cursorAfter is fixed, later inserts receive higher rowids and
 * cannot enlarge the range; concurrent deletes can only shrink it.
 */
export async function scanExpiredTokensWindow(
  db: RetentionGcCursorSqlExecutor,
  options: TokenGcWindowOptions = {},
): Promise<RetentionGcWindowScanResult> {
  const window = await scanRowidWindow(db, "tokens", options);
  if (window.scannedCount === 0) {
    return { ...window, expiredCount: 0 };
  }

  const cutoff = createTokenCutoff(options.now, options.expiryGraceSeconds);
  const row = await db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM tokens
        WHERE rowid > ?
          AND rowid <= ?
          AND expires_at IS NOT NULL
          AND expires_at < ?
      `,
    )
    .bind(window.cursorBefore, window.cursorAfter, cutoff)
    .first<{ count?: unknown }>();

  return { ...window, expiredCount: readCount(row?.count) };
}

/** Deletes expired tokens only inside a previously scanned closed window. */
export async function pruneExpiredTokensWindow(
  db: RetentionGcSqlExecutor,
  window: RetentionGcWindow,
  options: Pick<TokenGcWindowOptions, "now" | "expiryGraceSeconds"> = {},
): Promise<RetentionGcRunResult> {
  const normalizedWindow = normalizeClosedWindow(window);
  if (normalizedWindow.scannedCount === 0) {
    return { deletedCount: 0 };
  }

  const cutoff = createTokenCutoff(options.now, options.expiryGraceSeconds);
  const result = await db
    .prepare(
      `
        DELETE FROM tokens
        WHERE rowid > ?
          AND rowid <= ?
          AND expires_at IS NOT NULL
          AND expires_at < ?
      `,
    )
    .bind(normalizedWindow.cursorBefore, normalizedWindow.cursorAfter, cutoff)
    .run();

  return toGcRunResult(result);
}

/**
 * Examines the next bounded set of audit rows in intrinsic rowid order and
 * applies per-organization retention only inside that closed range.
 */
export async function scanExpiredAuditEntriesWindow(
  db: RetentionGcCursorSqlExecutor,
  options: RetentionGcWindowOptions = {},
): Promise<RetentionGcWindowScanResult> {
  const window = await scanRowidWindow(db, "audit_logs", options);
  if (window.scannedCount === 0) {
    return { ...window, expiredCount: 0 };
  }

  const now = normalizeNow(options.now).toISOString();
  const row = await db
    .prepare(AUDIT_RETENTION_WINDOW_COUNT_SQL)
    .bind(
      window.cursorBefore,
      window.cursorAfter,
      now,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    )
    .first<{ count?: unknown }>();

  return { ...window, expiredCount: readCount(row?.count) };
}

/** Deletes expired audit rows only inside a previously scanned closed window. */
export async function purgeExpiredAuditEntriesWindow(
  db: RetentionGcSqlExecutor,
  window: RetentionGcWindow,
  options: Pick<RetentionGcWindowOptions, "now"> = {},
): Promise<RetentionGcRunResult> {
  const normalizedWindow = normalizeClosedWindow(window);
  if (normalizedWindow.scannedCount === 0) {
    return { deletedCount: 0 };
  }

  const now = normalizeNow(options.now).toISOString();
  const result = await db
    .prepare(AUDIT_RETENTION_WINDOW_DELETE_SQL)
    .bind(
      normalizedWindow.cursorBefore,
      normalizedWindow.cursorAfter,
      now,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    )
    .run();

  return toGcRunResult(result);
}

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
  MAX_GC_WINDOW_SIZE,
};

async function scanRowidWindow(
  db: RetentionGcCursorSqlExecutor,
  table: "tokens" | "audit_logs",
  options: RetentionGcWindowOptions,
): Promise<RetentionGcWindow & { meta?: RetentionGcRunMeta }> {
  const cursorBefore = normalizeCursor(options.cursor);
  const limit = normalizeWindowSize(options.limit);
  const result = await db
    .prepare(`SELECT rowid AS rowid FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
    .bind(cursorBefore, limit)
    .all<{ rowid?: unknown }>();
  const rows = result.results ?? [];
  const rowids = rows.map((row) => readRowid(row.rowid));

  let previous = cursorBefore;
  for (const rowid of rowids) {
    if (rowid <= previous) {
      throw new Error("rowid window must be strictly increasing after cursor");
    }
    previous = rowid;
  }

  const cursorAfter = rowids.at(-1) ?? cursorBefore;
  return {
    cursorBefore,
    cursorAfter,
    scannedCount: rowids.length,
    exhausted: rowids.length < limit,
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

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

function normalizeWindowSize(value: number | undefined): number {
  const limit = value ?? DEFAULT_GC_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (limit > MAX_GC_WINDOW_SIZE) {
    throw new Error(`limit must not exceed ${MAX_GC_WINDOW_SIZE}`);
  }
  return limit;
}

function normalizeCursor(value: number | undefined): number {
  const cursor = value ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("cursor must be a non-negative safe integer");
  }
  return cursor;
}

function normalizeClosedWindow(window: RetentionGcWindow): RetentionGcWindow {
  const cursorBefore = normalizeCursor(window.cursorBefore);
  const cursorAfter = normalizeCursor(window.cursorAfter);
  if (!Number.isInteger(window.scannedCount)
    || window.scannedCount < 0
    || window.scannedCount > MAX_GC_WINDOW_SIZE) {
    throw new Error(`scannedCount must be between 0 and ${MAX_GC_WINDOW_SIZE}`);
  }
  if (window.scannedCount === 0 && cursorAfter !== cursorBefore) {
    throw new Error("empty window must not advance the cursor");
  }
  if (window.scannedCount > 0 && cursorAfter <= cursorBefore) {
    throw new Error("non-empty window must advance the cursor");
  }
  return {
    cursorBefore,
    cursorAfter,
    scannedCount: window.scannedCount,
    exhausted: Boolean(window.exhausted),
  };
}

function readRowid(value: unknown): number {
  const rowid = typeof value === "string" && /^\d+$/.test(value)
    ? Number.parseInt(value, 10)
    : value;
  if (typeof rowid !== "number" || !Number.isSafeInteger(rowid) || rowid < 1) {
    throw new Error("rowid window returned an invalid rowid");
  }
  return rowid;
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
