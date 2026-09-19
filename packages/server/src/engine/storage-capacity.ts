/**
 * Capacity guardrail for the backing store.
 *
 * This exists because running out of database is currently discovered through
 * failing runs rather than through an alert. The guardrail turns the approach
 * into a graded, observable signal.
 *
 * Two things shape the design:
 *
 * 1. **The size number is not always ours to read.** `PRAGMA page_count` is
 *    rejected outright on some hosted backends (Cloudflare D1 answers
 *    `not authorized: SQLITE_AUTH`), where the real size signal is the write
 *    metadata the platform returns on every query. A caller-supplied
 *    `sizeBytes` is therefore a first-class input, not a fallback; the pragma
 *    probe is the convenience path for Node/better-sqlite3 consumers and
 *    reports unavailability instead of throwing.
 *
 * 2. **Deleting rows does not shrink the file.** With `auto_vacuum = 0` — the
 *    default this schema has never changed — a delete moves pages onto the
 *    freelist and leaves the file byte-identical; only `VACUUM` returns the
 *    space, and hosted backends do not expose it. Retention therefore caps
 *    growth at the current high-water mark rather than reducing it. So the
 *    guardrail reports freelist bytes separately: after a large sweep a
 *    high-water-mark-full database with a large freelist is healthy, and looks
 *    identical to a genuinely full one if you only read the size.
 *
 * Pure and platform-agnostic: plain SQL through the same `prepare()` executor
 * shape the retention engine uses, no runtime-specific imports.
 */

export type StorageCapacityLevel = "ok" | "warn" | "critical";

export type StorageSizeSource = "reported" | "pragma" | "unavailable";

export type StorageSizeSample = {
  /** High-water mark in bytes, or null when no source could supply one. */
  sizeBytes: number | null;
  source: StorageSizeSource;
  /** Reusable bytes already inside the file. Absent when unknown. */
  freelistBytes?: number;
  pageSize?: number;
  pageCount?: number;
  freelistCount?: number;
};

export type StorageCapacityAssessment = {
  level: StorageCapacityLevel;
  sizeBytes: number;
  capacityBytes: number;
  usedRatio: number;
  headroomBytes: number;
  /** Bytes already inside the file that new writes can reuse without growth. */
  reclaimableBytes: number;
  /**
   * `usedRatio` discounted by the freelist: what the database would measure if
   * the file could be compacted. Never negative.
   */
  effectiveUsedRatio: number;
  warnRatio: number;
  criticalRatio: number;
};

export type StorageCapacityProjection = {
  /** Days until the high-water mark reaches capacity, or null when not growing. */
  daysRemaining: number | null;
  exhaustedAt: string | null;
};

export type TableFootprint = {
  table: string;
  rowCount: number;
};

export type PersistedStorageCapacitySample = {
  sizeBytes: number;
  capacityBytes?: number;
  freelistBytes?: number;
  observedAt: string;
};

export type StorageCapacitySettings = {
  /** Undefined means the guardrail is off: nothing is evaluated or logged. */
  capacityBytes?: number;
  warnRatio: number;
  criticalRatio: number;
  /** Undefined means identity-create shedding is off. */
  shedRatio?: number;
};

type SqlStatement = {
  bind(...params: unknown[]): SqlStatement;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
};

export type StorageCapacitySqlExecutor = {
  prepare(query: string): SqlStatement;
};

export const DEFAULT_STORAGE_CAPACITY_WARN_RATIO = 0.7;
export const DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO = 0.85;

/**
 * How stale a persisted sample may be before shedding stops trusting it.
 *
 * Shedding fails OPEN. A stale gauge means nobody is sampling, which is not
 * evidence that the database is full — and rejecting live traffic on a number
 * nobody has refreshed would be worse than the cliff it is meant to soften.
 */
export const DEFAULT_STORAGE_CAPACITY_SAMPLE_MAX_AGE_MS = 15 * 60_000;

/** How long an isolate may reuse a persisted sample before re-reading it. */
export const DEFAULT_STORAGE_CAPACITY_GAUGE_TTL_MS = 30_000;

const CANONICAL_POSITIVE_INT = /^[1-9][0-9]*$/;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CAPACITY_SAMPLE_ID = "current";

const PROBE_DATABASE_SIZE_SQL = `
  SELECT
    (SELECT * FROM pragma_page_count()) AS pageCount,
    (SELECT * FROM pragma_page_size()) AS pageSize,
    (SELECT * FROM pragma_freelist_count()) AS freelistCount
`;

/**
 * Reads the file's own size through SQLite pragmas.
 *
 * Returns an `unavailable` sample rather than throwing when the backend
 * refuses pragmas — that refusal is an expected deployment shape, not an
 * error, and the caller already has the reported-size path.
 */
export async function probeDatabaseSize(
  db: StorageCapacitySqlExecutor,
): Promise<StorageSizeSample> {
  try {
    const row = await db.prepare(PROBE_DATABASE_SIZE_SQL).first<{
      pageCount?: unknown;
      pageSize?: unknown;
      freelistCount?: unknown;
    }>();

    const pageCount = readNonNegativeInteger(row?.pageCount);
    const pageSize = readNonNegativeInteger(row?.pageSize);
    if (pageCount === null || pageSize === null || pageSize === 0) {
      return { sizeBytes: null, source: "unavailable" };
    }

    const freelistCount = readNonNegativeInteger(row?.freelistCount);
    return {
      sizeBytes: pageCount * pageSize,
      source: "pragma",
      pageCount,
      pageSize,
      ...(freelistCount === null
        ? {}
        : { freelistCount, freelistBytes: freelistCount * pageSize }),
    };
  } catch {
    return { sizeBytes: null, source: "unavailable" };
  }
}

/**
 * Resolves the size to assess, preferring a size the caller already observed.
 *
 * Hosted backends return their own size on every write; that number is
 * authoritative there and the pragma probe is unavailable, so a supplied
 * `sizeBytes` always wins and the probe runs only when none was given.
 */
export async function resolveStorageSizeSample(
  db: StorageCapacitySqlExecutor | null | undefined,
  reported: { sizeBytes?: number; freelistBytes?: number } = {},
): Promise<StorageSizeSample> {
  const reportedSize = readNonNegativeInteger(reported.sizeBytes);
  if (reportedSize !== null) {
    const reportedFreelist = readNonNegativeInteger(reported.freelistBytes);
    return {
      sizeBytes: reportedSize,
      source: "reported",
      ...(reportedFreelist === null ? {} : { freelistBytes: reportedFreelist }),
    };
  }

  if (!db) {
    return { sizeBytes: null, source: "unavailable" };
  }
  return probeDatabaseSize(db);
}

/**
 * Grades observed size against capacity.
 *
 * `usedRatio` is the number that decides the level, because the high-water mark
 * is what a hard cap actually measures. `effectiveUsedRatio` reports the same
 * ratio net of the freelist, which is what will be measured if the file is ever
 * compacted — the two diverge sharply after a large sweep, and reading only the
 * first would call a healthy post-GC database full.
 */
export function evaluateStorageCapacity(input: {
  sizeBytes: number;
  capacityBytes: number;
  warnRatio?: number;
  criticalRatio?: number;
  freelistBytes?: number;
}): StorageCapacityAssessment {
  const sizeBytes = requireNonNegativeInteger(input.sizeBytes, "sizeBytes");
  const capacityBytes = requirePositiveInteger(input.capacityBytes, "capacityBytes");
  const warnRatio = requireRatio(
    input.warnRatio ?? DEFAULT_STORAGE_CAPACITY_WARN_RATIO,
    "warnRatio",
  );
  const criticalRatio = requireRatio(
    input.criticalRatio ?? DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO,
    "criticalRatio",
  );
  if (criticalRatio < warnRatio) {
    throw new Error("criticalRatio must not be below warnRatio");
  }

  const reclaimableBytes = Math.min(
    sizeBytes,
    readNonNegativeInteger(input.freelistBytes) ?? 0,
  );
  const usedRatio = sizeBytes / capacityBytes;
  const effectiveUsedRatio = Math.max(0, (sizeBytes - reclaimableBytes) / capacityBytes);

  return {
    level: usedRatio >= criticalRatio ? "critical" : usedRatio >= warnRatio ? "warn" : "ok",
    sizeBytes,
    capacityBytes,
    usedRatio,
    headroomBytes: Math.max(0, capacityBytes - sizeBytes),
    reclaimableBytes,
    effectiveUsedRatio,
    warnRatio,
    criticalRatio,
  };
}

/**
 * Projects when the high-water mark reaches capacity at the observed growth
 * rate. The scheduler supplies growth from consecutive samples; a flat or
 * shrinking series projects null rather than a misleading infinity.
 */
export function projectTimeToCapacity(input: {
  sizeBytes: number;
  growthBytesPerDay: number;
  capacityBytes: number;
  now?: Date;
}): StorageCapacityProjection {
  const sizeBytes = requireNonNegativeInteger(input.sizeBytes, "sizeBytes");
  const capacityBytes = requirePositiveInteger(input.capacityBytes, "capacityBytes");
  const growthBytesPerDay = input.growthBytesPerDay;
  if (!Number.isFinite(growthBytesPerDay)) {
    throw new Error("growthBytesPerDay must be a finite number");
  }
  if (growthBytesPerDay <= 0) {
    return { daysRemaining: null, exhaustedAt: null };
  }

  const daysRemaining = Math.max(0, (capacityBytes - sizeBytes) / growthBytesPerDay);
  const now = normalizeNow(input.now);
  return {
    daysRemaining,
    exhaustedAt: new Date(
      now.getTime() + daysRemaining * 24 * 60 * 60 * 1_000,
    ).toISOString(),
  };
}

/**
 * Counts rows per table so an alert can name what is consuming the database
 * rather than only that it is filling.
 *
 * Table names are interpolated (SQLite cannot parameterize an identifier), so
 * each is validated against a bare-identifier pattern first. Missing tables are
 * skipped: a caller may reasonably ask about tables a given schema version does
 * not have yet.
 */
export async function collectTableFootprint(
  db: StorageCapacitySqlExecutor,
  tables: readonly string[],
): Promise<TableFootprint[]> {
  const footprint: TableFootprint[] = [];
  for (const table of tables) {
    if (!SQL_IDENTIFIER.test(table)) {
      throw new Error(`table name must be a bare SQL identifier: ${table}`);
    }
    try {
      const row = await db
        .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
        .first<{ count?: unknown }>();
      footprint.push({ table, rowCount: readNonNegativeInteger(row?.count) ?? 0 });
    } catch {
      continue;
    }
  }

  return footprint.sort(
    (left, right) => right.rowCount - left.rowCount || left.table.localeCompare(right.table),
  );
}

/**
 * Persists the latest observed size.
 *
 * The sample has to survive the process that took it: the sweep that can read
 * the size and the request path that wants to act on it do not share an
 * isolate on every runtime, so a module-scope value alone is unreadable from a
 * request. One row, overwritten in place.
 */
export async function recordStorageCapacitySample(
  db: StorageCapacitySqlExecutor,
  sample: { sizeBytes: number; capacityBytes?: number; freelistBytes?: number; now?: Date },
): Promise<PersistedStorageCapacitySample> {
  const sizeBytes = requireNonNegativeInteger(sample.sizeBytes, "sizeBytes");
  const capacityBytes = readNonNegativeInteger(sample.capacityBytes);
  const freelistBytes = readNonNegativeInteger(sample.freelistBytes);
  const observedAt = normalizeNow(sample.now).toISOString();

  await db
    .prepare(
      `
        INSERT INTO storage_capacity_samples (
          id, size_bytes, capacity_bytes, freelist_bytes, observed_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE
        SET size_bytes = excluded.size_bytes,
            capacity_bytes = excluded.capacity_bytes,
            freelist_bytes = excluded.freelist_bytes,
            observed_at = excluded.observed_at
      `,
    )
    .bind(CAPACITY_SAMPLE_ID, sizeBytes, capacityBytes, freelistBytes, observedAt)
    .run();

  return {
    sizeBytes,
    ...(capacityBytes === null ? {} : { capacityBytes }),
    ...(freelistBytes === null ? {} : { freelistBytes }),
    observedAt,
  };
}

/** Reads the persisted sample, or null when none has been recorded. */
export async function readStorageCapacitySample(
  db: StorageCapacitySqlExecutor,
): Promise<PersistedStorageCapacitySample | null> {
  const row = await db
    .prepare(
      `
        SELECT size_bytes, capacity_bytes, freelist_bytes, observed_at
        FROM storage_capacity_samples
        WHERE id = ?
      `,
    )
    .bind(CAPACITY_SAMPLE_ID)
    .first<{
      size_bytes?: unknown;
      capacity_bytes?: unknown;
      freelist_bytes?: unknown;
      observed_at?: unknown;
    }>();

  const sizeBytes = readNonNegativeInteger(row?.size_bytes);
  const observedAt = typeof row?.observed_at === "string" ? row.observed_at : null;
  if (sizeBytes === null || !observedAt) {
    return null;
  }

  const capacityBytes = readNonNegativeInteger(row?.capacity_bytes);
  const freelistBytes = readNonNegativeInteger(row?.freelist_bytes);
  return {
    sizeBytes,
    ...(capacityBytes === null ? {} : { capacityBytes }),
    ...(freelistBytes === null ? {} : { freelistBytes }),
    observedAt,
  };
}

/**
 * Per-isolate cache over the persisted sample.
 *
 * Shedding is checked on a hot path, so without this the opt-in would add a
 * read to every identity create. The sample changes only as often as the sweep
 * that records it, so a short TTL costs at most a couple of reads per minute
 * per isolate and nothing at all while shedding is off.
 */
export class StorageCapacityGauge {
  /**
   * Keyed BY EXECUTOR, not a single slot. `sharedStorageCapacityGauge` is a
   * module-level singleton and `createApp` accepts injected storage, so two
   * apps backed by DIFFERENT databases can share one gauge within a process. A
   * single slot would hand app B the sample app A took, and a 95%-full database
   * would start shedding creates on an empty one. A WeakMap also lets a
   * retired executor's sample be collected with it.
   */
  #cache = new WeakMap<
    StorageCapacitySqlExecutor,
    { sample: PersistedStorageCapacitySample | null; readAtMs: number }
  >();

  constructor(readonly ttlMs: number = DEFAULT_STORAGE_CAPACITY_GAUGE_TTL_MS) {}

  async read(
    db: StorageCapacitySqlExecutor,
    options: { now?: Date } = {},
  ): Promise<PersistedStorageCapacitySample | null> {
    const nowMs = normalizeNow(options.now).getTime();
    const entry = this.#cache.get(db);
    if (entry && nowMs - entry.readAtMs < this.ttlMs) {
      return entry.sample;
    }

    let sample: PersistedStorageCapacitySample | null;
    try {
      sample = await readStorageCapacitySample(db);
    } catch {
      // A store that cannot answer must not fail the request it is guarding.
      sample = null;
    }
    this.#cache.set(db, { sample, readAtMs: nowMs });
    return sample;
  }

  /** Seeds the cache from a sample this isolate just took for `db`. */
  record(
    db: StorageCapacitySqlExecutor,
    sample: PersistedStorageCapacitySample,
    options: { now?: Date } = {},
  ): void {
    this.#cache.set(db, {
      sample,
      readAtMs: normalizeNow(options.now).getTime(),
    });
  }

  /**
   * Drops one executor's cached sample, or every sample when called with no
   * executor. A WeakMap cannot be enumerated, so the whole-gauge reset swaps in
   * a fresh map rather than clearing in place.
   */
  reset(db?: StorageCapacitySqlExecutor): void {
    if (db) {
      this.#cache.delete(db);
      return;
    }
    this.#cache = new WeakMap();
  }
}

/**
 * Shared per-isolate gauge. Mirrors the rate limiters' module-scope shape: the
 * hosted entrypoint builds an app per request, so anything cached inside
 * `createApp()` would be discarded before it could be reused.
 */
export const sharedStorageCapacityGauge = new StorageCapacityGauge();

/**
 * Decides whether an identity create should shed load.
 *
 * Fails OPEN at every uncertainty — shedding off, capacity unset, no sample,
 * stale sample. This converts a hard wall into a typed retryable signal for
 * deployments that opt in; it must never be able to reject traffic on its own.
 */
export function shouldShedForStorageCapacity(input: {
  sample: PersistedStorageCapacitySample | null;
  settings: StorageCapacitySettings;
  now?: Date;
  maxSampleAgeMs?: number;
}): { shed: boolean; assessment?: StorageCapacityAssessment; reason?: string } {
  const { settings, sample } = input;
  if (settings.shedRatio === undefined) {
    return { shed: false, reason: "shedding_disabled" };
  }

  // The CONFIGURED ceiling is the sole runtime authority. Falling back to
  // `sample.capacityBytes` would keep shedding against a ceiling an operator
  // has just removed: persisted samples carry the old value, so unsetting
  // RELAYAUTH_STORAGE_CAPACITY_BYTES while a shed ratio remains set would go on
  // rejecting creates until a later sample happened to overwrite it. Removing
  // the binding must disable shedding immediately.
  const capacityBytes = settings.capacityBytes;
  if (capacityBytes === undefined || capacityBytes <= 0) {
    return { shed: false, reason: "capacity_unset" };
  }
  if (!sample) {
    return { shed: false, reason: "no_sample" };
  }

  const maxAgeMs = input.maxSampleAgeMs ?? DEFAULT_STORAGE_CAPACITY_SAMPLE_MAX_AGE_MS;
  const observedAtMs = Date.parse(sample.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    return { shed: false, reason: "sample_unreadable" };
  }
  if (normalizeNow(input.now).getTime() - observedAtMs > maxAgeMs) {
    return { shed: false, reason: "sample_stale" };
  }

  const assessment = evaluateStorageCapacity({
    sizeBytes: sample.sizeBytes,
    capacityBytes,
    warnRatio: settings.warnRatio,
    criticalRatio: settings.criticalRatio,
    ...(sample.freelistBytes === undefined ? {} : { freelistBytes: sample.freelistBytes }),
  });

  // Shed on the freelist-adjusted ratio. A post-sweep database sitting at its
  // high-water mark with gigabytes of reusable pages can absorb writes without
  // growing, and rejecting creates there would be a false alarm.
  return assessment.effectiveUsedRatio >= settings.shedRatio
    ? { shed: true, assessment }
    : { shed: false, assessment, reason: "below_shed_ratio" };
}

/**
 * Reads the guardrail's bindings.
 *
 * Every setting fails SAFE: absent, empty, or malformed leaves the guardrail
 * off or falls back to the protective default. A fat-fingered binding must not
 * be able to disable a ceiling or take a route offline.
 */
export function resolveStorageCapacitySettings(config: {
  RELAYAUTH_STORAGE_CAPACITY_BYTES?: string;
  RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO?: string;
  RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO?: string;
  RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO?: string;
}): StorageCapacitySettings {
  const capacityBytes = parseCapacityBytesSetting(
    config.RELAYAUTH_STORAGE_CAPACITY_BYTES,
    "RELAYAUTH_STORAGE_CAPACITY_BYTES",
  );
  const warnRatio = parseCapacityRatioSetting(
    config.RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO,
    "RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO",
  ) ?? DEFAULT_STORAGE_CAPACITY_WARN_RATIO;
  const parsedCritical = parseCapacityRatioSetting(
    config.RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO,
    "RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO",
  ) ?? DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO;
  // An inverted pair would make `critical` unreachable and silently downgrade
  // every alert to `warn`, so raise critical to meet warn rather than accept it.
  const criticalRatio = Math.max(warnRatio, parsedCritical);
  const shedRatio = parseCapacityRatioSetting(
    config.RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO,
    "RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO",
  );

  return {
    ...(capacityBytes === undefined ? {} : { capacityBytes }),
    warnRatio,
    criticalRatio,
    ...(shedRatio === undefined ? {} : { shedRatio }),
  };
}

/** Undefined means "capacity unknown", which leaves the guardrail off. */
export function parseCapacityBytesSetting(
  value: string | undefined,
  name: string,
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!CANONICAL_POSITIVE_INT.test(trimmed)) {
    console.warn(`${name} must be a canonical positive integer; guardrail stays off`, {
      received: trimmed,
    });
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    console.warn(`${name} is out of safe integer range; guardrail stays off`, {
      received: trimmed,
    });
    return undefined;
  }
  return parsed;
}

/** Undefined means "unset"; the caller decides whether that is a default or off. */
export function parseCapacityRatioSetting(
  value: string | undefined,
  name: string,
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    console.warn(`${name} must be a ratio in (0, 1]; ignoring`, { received: trimmed });
    return undefined;
  }
  return parsed;
}

/**
 * Emits the structured line alerting keys off. Silent at `ok` so a healthy
 * sweep costs nothing, and `error` at `critical` so the two levels are
 * distinguishable without parsing the payload.
 */
export function logStorageCapacity(
  assessment: StorageCapacityAssessment,
  context: Record<string, unknown> = {},
): void {
  if (assessment.level === "ok") {
    return;
  }

  const payload = {
    event: "relayauth.storage.capacity",
    level: assessment.level,
    sizeBytes: assessment.sizeBytes,
    capacityBytes: assessment.capacityBytes,
    usedRatio: Number(assessment.usedRatio.toFixed(4)),
    effectiveUsedRatio: Number(assessment.effectiveUsedRatio.toFixed(4)),
    headroomBytes: assessment.headroomBytes,
    reclaimableBytes: assessment.reclaimableBytes,
    ...context,
  };

  if (assessment.level === "critical") {
    console.error("relayauth.storage.capacity", payload);
    return;
  }
  console.warn("relayauth.storage.capacity", payload);
}

/**
 * Narrows an unknown value to a SQL executor this module can use.
 *
 * Deliberately duck-typed. `AuthStorage` does not expose a raw executor, and
 * adding one would be a storage-contract change requiring a coordinated
 * adapter update; this instead lets deployments whose storage happens to
 * expose one get the pragma probe, and leaves everyone else on the reported
 * size path with no interface change at all.
 */
export function asStorageCapacitySqlExecutor(
  candidate: unknown,
): StorageCapacitySqlExecutor | null {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { prepare?: unknown }).prepare === "function"
  ) {
    return candidate as StorageCapacitySqlExecutor;
  }
  return null;
}

function normalizeNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  return now;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number.parseInt(value.trim(), 10)
    : typeof value === "bigint"
      ? Number(value)
      : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  const parsed = readNonNegativeInteger(value);
  if (parsed === null) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const parsed = requireNonNegativeInteger(value, name);
  if (parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function requireRatio(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a ratio in (0, 1]`);
  }
  return value;
}
