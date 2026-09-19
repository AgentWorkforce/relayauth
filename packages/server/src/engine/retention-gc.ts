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

export type IdentityGcWindowOptions = RetentionGcWindowOptions & {
  /**
   * Treat a token that expired this recently as still live. Defaults to the
   * verifier's accepted clock skew, so an identity is never swept while one of
   * its tokens can still be considered valid.
   */
  tokenGraceSeconds?: number;
};

export type RetentionGcWindow = {
  cursorBefore: number;
  cursorAfter: number;
  scannedCount: number;
  exhausted: boolean;
  /** Stable primary-key evidence for expired rows observed by the scan. */
  candidateIds?: readonly string[];
};

export type RetentionGcWindowScanResult = RetentionGcWindow & {
  candidateIds: readonly string[];
  expiredCount: number;
  /** D1 query metadata for the bounded existing-row scan, when supplied by the executor. */
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

// Bounds on a per-organization identity retention window. A config row outside
// these bounds is ignored entirely rather than clamped: identity deletion is
// irreversible, so a malformed window must retain rather than guess.
const MIN_IDENTITY_RETENTION_DAYS = 1;
const MAX_IDENTITY_RETENTION_DAYS = 3_650;

/**
 * Every condition an identity row must satisfy before retention may delete it.
 *
 * One fragment, reused verbatim by the scan projection, the count, and the
 * DELETE, so the evidence a sweep gathers and the predicate its mutation
 * re-asserts can never drift apart. Bound parameters, in order:
 *
 *   1. minimum retention days      4. `now` (activity cutoff)
 *   2. maximum retention days      5. token liveness cutoff, Unix seconds
 *   3. `now` (creation cutoff)
 *
 * The conditions, in order:
 *
 * - The organization has an explicitly enabled config row with a sane window.
 *   No row, `enabled = 0`, or a malformed `retention_days` means never sweep;
 *   there is deliberately no implicit default.
 * - The row predates the window, compared against a `YYYY-MM-DD` cutoff the
 *   same conservative way audit retention does — a row on the boundary day is
 *   kept up to a day longer rather than deleted early.
 * - `last_active_at` is unset or equally stale.
 * - No live token references it. A token counts as live while it is `active`
 *   and either has no expiry at all (legacy rows whose liveness storage cannot
 *   settle, so they fail safe) or expires at or after the grace cutoff. The
 *   indefinite durable token class (#90) needs no special case: its far-future
 *   expiry satisfies the same comparison.
 * - It sponsors no surviving identity in its own organization, so a sweep can
 *   never orphan a live sponsor chain. Scoped by `org_id` so the lookup rides
 *   `idx_identities_org_sponsor`, and self-referential rows cannot pin
 *   themselves forever.
 * - It is not pinned by `metadata.retention = 'keep'`. Metadata that does not
 *   parse retains the row: an unreadable opt-out is indistinguishable from an
 *   opt-out that is present. The extraction sits inside a `CASE` because SQLite
 *   does not promise a preceding `json_valid` is evaluated first, and
 *   `json_extract` raises rather than returning NULL on malformed input.
 *
 * Status is deliberately absent. The identities this drains stay `active`
 * forever because nothing retires them, so age plus the absence of live tokens
 * is what makes a row collectable.
 *
 * RECENTLY-ISSUED TOKENS ALSO PIN A ROW, and that clause is load-bearing rather
 * than belt-and-braces. `last_active_at` is only ever written by PATCH, so it is
 * NULL on virtually every row and cannot signal use. Once a caller REUSES one
 * identity across mints (AgentWorkforce/cloud#3819) the reused identity is old,
 * has a NULL `last_active_at`, and is momentarily token-less between expiries —
 * matching every remaining clause while in active daily use. Collecting it
 * leaves the caller's durable mapping pointing at an identity that no longer
 * exists. Liveness of the CURRENT token is therefore not a sufficient guard;
 * "issued a token within the retention window" is.
 *
 * That recency is read from `token_lineages` as well as `tokens`, and the
 * lineage row is the one that matters: `pruneExpiredTokensWindow` DELETES a
 * token row once it expires, so pinning on `tokens` alone would be undone by
 * the sibling sweep — run the token sweep first and the reused identity goes
 * back to matching every clause, which is the exact failure this pin exists to
 * prevent. `token_lineages` is never swept (0008 created it as a permanent
 * historical record, which is also why identity deletion does not break
 * revoke-by-{workspace,agentName}), so it still carries the evidence. The
 * `tokens` clause is kept as belt-and-braces for any mint path that writes a
 * token without a lineage row. `idx_token_lineages_identity_created` already
 * covers the lookup.
 */
const IDENTITY_RETENTION_ELIGIBLE_SQL = `
  EXISTS (
    SELECT 1
    FROM identity_retention_config AS config
    WHERE config.org_id = identities.org_id
      AND config.enabled = 1
      AND typeof(config.retention_days) = 'integer'
      AND config.retention_days BETWEEN ? AND ?
      AND identities.created_at < date(?, printf('-%d days', config.retention_days))
      AND (
        identities.last_active_at IS NULL
        OR identities.last_active_at < date(?, printf('-%d days', config.retention_days))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tokens
        WHERE tokens.identity_id = identities.id
          AND tokens.created_at >= date(?, printf('-%d days', config.retention_days))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM token_lineages
        WHERE token_lineages.identity_id = identities.id
          AND token_lineages.created_at >= date(?, printf('-%d days', config.retention_days))
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM tokens
    WHERE tokens.identity_id = identities.id
      AND tokens.status = 'active'
      AND (tokens.expires_at IS NULL OR tokens.expires_at >= ?)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM identities AS child
    WHERE child.org_id = identities.org_id
      AND child.sponsor_id = identities.id
      AND child.id <> identities.id
  )
  AND (
    CASE
      WHEN json_valid(identities.metadata_json)
        THEN json_extract(identities.metadata_json, '$.retention')
      ELSE 'keep'
    END
  ) IS NOT 'keep'
`;

const IDENTITY_RETENTION_WINDOW_SCAN_SQL = `
  SELECT
    identities.rowid AS rowid,
    identities.id AS id,
    CASE WHEN ${IDENTITY_RETENTION_ELIGIBLE_SQL} THEN 1 ELSE 0 END AS expired
  FROM identities
  WHERE identities.rowid > ?
  ORDER BY identities.rowid
  LIMIT ?
`;

const IDENTITY_RETENTION_WINDOW_DELETE_SQL = `
  DELETE FROM identities
  WHERE id IN (
      SELECT value
      FROM json_each(?)
      WHERE type = 'text'
    )
    AND ${IDENTITY_RETENTION_ELIGIBLE_SQL}
`;

const IDENTITY_RETENTION_WINDOW_COUNT_SQL = `
  SELECT COUNT(*) AS count
  FROM (
    SELECT
      CASE WHEN ${IDENTITY_RETENTION_ELIGIBLE_SQL} THEN 1 ELSE 0 END AS expired
    FROM identities
    WHERE identities.rowid > ?
    ORDER BY identities.rowid
    LIMIT ?
  )
  WHERE expired = 1
`;

const AUDIT_RETENTION_WINDOW_SCAN_SQL = `
  SELECT
    logs.rowid AS rowid,
    logs.id AS id,
    CASE WHEN logs.created_at < date(
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
    ) THEN 1 ELSE 0 END AS expired
  FROM audit_logs AS logs
  LEFT JOIN audit_retention_config AS config
    ON config.org_id = logs.org_id
  WHERE logs.rowid > ?
  ORDER BY logs.rowid
  LIMIT ?
`;

const AUDIT_RETENTION_WINDOW_DELETE_SQL = `
  DELETE FROM audit_logs
  WHERE id IN (
      SELECT value
      FROM json_each(?)
      WHERE type = 'text'
    )
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
 * order and carries the stable IDs of expired candidates into the mutation.
 *
 * Expiry is projected onto the same LIMITed rows rather than counted in a
 * second numeric range. Sparse rowid gaps therefore do not add expiry work,
 * and later rowid reuse cannot enlarge the observed candidate set.
 */
export async function scanExpiredTokensWindow(
  db: RetentionGcCursorSqlExecutor,
  options: TokenGcWindowOptions = {},
): Promise<RetentionGcWindowScanResult> {
  const cursorBefore = normalizeCursor(options.cursor);
  const limit = normalizeWindowSize(options.limit);
  const cutoff = createTokenCutoff(options.now, options.expiryGraceSeconds);
  const result = await db
    .prepare(
      `
        SELECT
          rowid AS rowid,
          id AS id,
          CASE
            WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1
            ELSE 0
          END AS expired
        FROM tokens
        WHERE rowid > ?
        ORDER BY rowid
        LIMIT ?
      `,
    )
    .bind(cutoff, cursorBefore, limit)
    .all<RetentionGcCandidateRow>();

  return buildCandidateWindow(result, cursorBefore, limit);
}

/** Deletes only the stable token candidates carried by a prior bounded scan. */
export async function pruneExpiredTokensWindow(
  db: RetentionGcSqlExecutor,
  window: RetentionGcWindow,
  options: Pick<TokenGcWindowOptions, "now" | "expiryGraceSeconds"> = {},
): Promise<RetentionGcRunResult> {
  const normalizedWindow = normalizeClosedWindow(window);
  if (normalizedWindow.candidateIds.length === 0) {
    return { deletedCount: 0 };
  }

  const cutoff = createTokenCutoff(options.now, options.expiryGraceSeconds);
  const result = await db
    .prepare(
      `
        DELETE FROM tokens
        WHERE id IN (
            SELECT value
            FROM json_each(?)
            WHERE type = 'text'
          )
          AND expires_at IS NOT NULL
          AND expires_at < ?
      `,
    )
    .bind(JSON.stringify(normalizedWindow.candidateIds), cutoff)
    .run();

  return toGcRunResult(result);
}

/**
 * Examines the next bounded set of audit rows in intrinsic rowid order,
 * projecting per-organization expiry onto those same rows.
 */
export async function scanExpiredAuditEntriesWindow(
  db: RetentionGcCursorSqlExecutor,
  options: RetentionGcWindowOptions = {},
): Promise<RetentionGcWindowScanResult> {
  const cursorBefore = normalizeCursor(options.cursor);
  const limit = normalizeWindowSize(options.limit);
  const now = normalizeNow(options.now).toISOString();
  const result = await db
    .prepare(AUDIT_RETENTION_WINDOW_SCAN_SQL)
    .bind(
      now,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
      cursorBefore,
      limit,
    )
    .all<RetentionGcCandidateRow>();

  return buildCandidateWindow(result, cursorBefore, limit);
}

/** Deletes only the stable audit candidates carried by a prior bounded scan. */
export async function purgeExpiredAuditEntriesWindow(
  db: RetentionGcSqlExecutor,
  window: RetentionGcWindow,
  options: Pick<RetentionGcWindowOptions, "now"> = {},
): Promise<RetentionGcRunResult> {
  const normalizedWindow = normalizeClosedWindow(window);
  if (normalizedWindow.candidateIds.length === 0) {
    return { deletedCount: 0 };
  }

  const now = normalizeNow(options.now).toISOString();
  const result = await db
    .prepare(AUDIT_RETENTION_WINDOW_DELETE_SQL)
    .bind(
      JSON.stringify(normalizedWindow.candidateIds),
      now,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
    )
    .run();

  return toGcRunResult(result);
}

/**
 * Examines the next bounded set of identity rows in intrinsic rowid order and
 * carries the stable IDs of retention-eligible rows into the mutation.
 *
 * Eligibility is projected onto the same LIMITed rows the sweep scanned, so a
 * 1.09M-row table costs exactly one bounded window per call regardless of how
 * many rows happen to be collectable. Organizations that have not explicitly
 * enabled retention simply project as not-eligible, which is what keeps this
 * inert on every deployment that has not opted in.
 */
export async function scanStaleIdentitiesWindow(
  db: RetentionGcCursorSqlExecutor,
  options: IdentityGcWindowOptions = {},
): Promise<RetentionGcWindowScanResult> {
  const cursorBefore = normalizeCursor(options.cursor);
  const limit = normalizeWindowSize(options.limit);
  const result = await db
    .prepare(IDENTITY_RETENTION_WINDOW_SCAN_SQL)
    .bind(...identityEligibilityParams(options), cursorBefore, limit)
    .all<RetentionGcCandidateRow>();

  return buildCandidateWindow(result, cursorBefore, limit);
}

/**
 * Deletes only the stable identity candidates carried by a prior bounded scan.
 *
 * The full eligibility predicate is re-asserted inside the DELETE. A row that
 * gained a live token, gained a sponsored child, or was pinned between the scan
 * and this mutation therefore survives, and a rowid reused by an unrelated row
 * is never swept on evidence gathered before that row existed.
 *
 * Nothing here revokes: the predicate has already established that no active,
 * unexpired token references the row. Lineage is intentionally untouched —
 * migration 0008 records it without foreign keys precisely so it survives as
 * the historical record of an identity that is no longer operational, and 0010
 * persists the agent name on `token_lineages` so workspace-agent revocation
 * keeps resolving path tokens afterwards.
 */
export async function pruneStaleIdentitiesWindow(
  db: RetentionGcSqlExecutor,
  window: RetentionGcWindow,
  options: Pick<IdentityGcWindowOptions, "now" | "tokenGraceSeconds"> = {},
): Promise<RetentionGcRunResult> {
  const normalizedWindow = normalizeClosedWindow(window);
  if (normalizedWindow.candidateIds.length === 0) {
    return { deletedCount: 0 };
  }

  const result = await db
    .prepare(IDENTITY_RETENTION_WINDOW_DELETE_SQL)
    .bind(
      JSON.stringify(normalizedWindow.candidateIds),
      ...identityEligibilityParams(options),
    )
    .run();

  return toGcRunResult(result);
}

/**
 * Counts retention-eligible identities inside the next bounded rowid window.
 *
 * Bounded by rows scanned rather than by matches found, so a dry run costs the
 * same as the sweep it previews and reports exactly what that sweep would
 * delete. Deletes nothing.
 */
export async function countStaleIdentitiesBatch(
  db: RetentionGcSqlExecutor,
  options: IdentityGcWindowOptions = {},
): Promise<{ expiredCount: number }> {
  const cursor = normalizeCursor(options.cursor);
  const limit = normalizeWindowSize(options.limit);
  const row = await db
    .prepare(IDENTITY_RETENTION_WINDOW_COUNT_SQL)
    .bind(...identityEligibilityParams(options), cursor, limit)
    .first<{ count?: unknown }>();

  return { expiredCount: readCount(row?.count) };
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
 * retention period, or the two-day default when the config row is absent.
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
  MAX_IDENTITY_RETENTION_DAYS,
  MIN_IDENTITY_RETENTION_DAYS,
};

/** Bound parameters for {@link IDENTITY_RETENTION_ELIGIBLE_SQL}, in order. */
function identityEligibilityParams(
  options: Pick<IdentityGcWindowOptions, "now" | "tokenGraceSeconds">,
): [number, number, string, string, string, string, number] {
  const now = normalizeNow(options.now);
  const nowIso = now.toISOString();
  return [
    MIN_IDENTITY_RETENTION_DAYS,
    MAX_IDENTITY_RETENTION_DAYS,
    nowIso,
    nowIso,
    // `tokens.created_at` cutoff: a token issued inside the retention window
    // pins its identity even when that token has since expired.
    nowIso,
    // `token_lineages.created_at` cutoff: the same signal, on the table the
    // token sweep never deletes.
    nowIso,
    createTokenCutoff(now, options.tokenGraceSeconds),
  ];
}

type RetentionGcCandidateRow = {
  rowid?: unknown;
  id?: unknown;
  expired?: unknown;
};

function buildCandidateWindow(
  result: SqlAllResult<RetentionGcCandidateRow>,
  cursorBefore: number,
  limit: number,
): RetentionGcWindowScanResult {
  const rows = result.results ?? [];
  const rowids: number[] = [];
  const candidateIds: string[] = [];
  const observedIds = new Set<string>();

  let previous = cursorBefore;
  for (const row of rows) {
    const rowid = readRowid(row.rowid);
    if (rowid <= previous) {
      throw new Error("rowid window must be strictly increasing after cursor");
    }
    previous = rowid;
    rowids.push(rowid);

    const id = readStableId(row.id);
    if (observedIds.has(id)) {
      throw new Error("candidate window returned a duplicate stable id");
    }
    observedIds.add(id);
    if (readExpiredFlag(row.expired)) {
      candidateIds.push(id);
    }
  }

  const cursorAfter = rowids.at(-1) ?? cursorBefore;
  return {
    cursorBefore,
    cursorAfter,
    scannedCount: rowids.length,
    candidateIds,
    expiredCount: candidateIds.length,
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

function normalizeClosedWindow(
  window: RetentionGcWindow,
): RetentionGcWindow & { candidateIds: readonly string[] } {
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

  if (!Array.isArray(window.candidateIds)) {
    throw new Error("window must include candidateIds from its bounded scan");
  }
  if (window.candidateIds.length > window.scannedCount
    || window.candidateIds.length > MAX_GC_WINDOW_SIZE) {
    throw new Error("candidateIds must not exceed the scanned window");
  }
  const candidateIds = window.candidateIds.map((id) => readStableId(id));
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("candidateIds must not contain duplicates");
  }
  const expiredCount = (window as RetentionGcWindow & { expiredCount?: unknown }).expiredCount;
  if (expiredCount !== undefined && readCountStrict(expiredCount) !== candidateIds.length) {
    throw new Error("expiredCount must match candidateIds evidence");
  }
  return {
    cursorBefore,
    cursorAfter,
    scannedCount: window.scannedCount,
    exhausted: Boolean(window.exhausted),
    candidateIds,
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

function readStableId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("candidate window returned an invalid stable id");
  }
  return value;
}

function readExpiredFlag(value: unknown): boolean {
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  throw new Error("candidate window returned an invalid expiry flag");
}

function readCountStrict(value: unknown): number {
  const count = typeof value === "string" && /^\d+$/.test(value)
    ? Number.parseInt(value, 10)
    : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("expiredCount must be a non-negative safe integer");
  }
  return count;
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
