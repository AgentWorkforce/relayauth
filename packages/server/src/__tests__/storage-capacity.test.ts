import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  asStorageCapacitySqlExecutor,
  collectTableFootprint,
  DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO,
  DEFAULT_STORAGE_CAPACITY_SAMPLE_MAX_AGE_MS,
  DEFAULT_STORAGE_CAPACITY_WARN_RATIO,
  evaluateStorageCapacity,
  logStorageCapacity,
  probeDatabaseSize,
  projectTimeToCapacity,
  readStorageCapacitySample,
  recordStorageCapacitySample,
  resolveStorageCapacitySettings,
  resolveStorageSizeSample,
  shouldShedForStorageCapacity,
  StorageCapacityGauge,
  type StorageCapacitySqlExecutor,
} from "../engine/storage-capacity.js";
import { createSqliteStorage, type SqliteStorage } from "../storage/sqlite.js";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const GB = 1_024 ** 3;

function createStorage(t: TestContext): {
  storage: SqliteStorage;
  db: StorageCapacitySqlExecutor;
} {
  const storage = createSqliteStorage(":memory:");
  t.after(async () => storage.close());
  return {
    storage,
    db: storage.DB as unknown as StorageCapacitySqlExecutor,
  };
}

function captureConsole(t: TestContext): { warn: unknown[][]; error: unknown[][] } {
  const captured = { warn: [] as unknown[][], error: [] as unknown[][] };
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => captured.warn.push(args);
  console.error = (...args: unknown[]) => captured.error.push(args);
  t.after(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });
  return captured;
}

test("capacity levels grade the high-water mark against the ceiling", (t) => {
  const ok = evaluateStorageCapacity({ sizeBytes: 5 * GB, capacityBytes: 10 * GB });
  assert.equal(ok.level, "ok");
  assert.equal(ok.usedRatio, 0.5);
  assert.equal(ok.headroomBytes, 5 * GB);

  assert.equal(
    evaluateStorageCapacity({ sizeBytes: 7 * GB, capacityBytes: 10 * GB }).level,
    "warn",
  );
  // Thresholds are inclusive so a database sitting exactly on the line alerts.
  assert.equal(
    evaluateStorageCapacity({
      sizeBytes: DEFAULT_STORAGE_CAPACITY_WARN_RATIO * 10 * GB,
      capacityBytes: 10 * GB,
    }).level,
    "warn",
  );
  assert.equal(
    evaluateStorageCapacity({
      sizeBytes: DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO * 10 * GB,
      capacityBytes: 10 * GB,
    }).level,
    "critical",
  );

  const full = evaluateStorageCapacity({ sizeBytes: 12 * GB, capacityBytes: 10 * GB });
  assert.equal(full.level, "critical");
  assert.equal(full.headroomBytes, 0, "headroom never goes negative");

  void t;
});

test("freelist headroom is reported separately from the raw size", () => {
  // The post-sweep shape: deleting rows moved pages to the freelist without
  // shrinking the file, so size alone is indistinguishable from genuinely full.
  const swept = evaluateStorageCapacity({
    sizeBytes: 9 * GB,
    capacityBytes: 10 * GB,
    freelistBytes: 6 * GB,
  });
  assert.equal(swept.level, "critical", "the hard cap still measures the high-water mark");
  assert.equal(swept.reclaimableBytes, 6 * GB);
  assert.ok(Math.abs(swept.effectiveUsedRatio - 0.3) < 1e-9);

  const genuinelyFull = evaluateStorageCapacity({
    sizeBytes: 9 * GB,
    capacityBytes: 10 * GB,
  });
  assert.equal(genuinelyFull.reclaimableBytes, 0);
  assert.equal(genuinelyFull.usedRatio, genuinelyFull.effectiveUsedRatio);

  // A freelist larger than the file is nonsense; clamp rather than report a
  // negative effective ratio.
  const clamped = evaluateStorageCapacity({
    sizeBytes: 1 * GB,
    capacityBytes: 10 * GB,
    freelistBytes: 5 * GB,
  });
  assert.equal(clamped.reclaimableBytes, 1 * GB);
  assert.equal(clamped.effectiveUsedRatio, 0);
});

test("capacity evaluation refuses incoherent inputs", () => {
  assert.throws(
    () => evaluateStorageCapacity({ sizeBytes: 1, capacityBytes: 0 }),
    /capacityBytes/,
  );
  assert.throws(
    () => evaluateStorageCapacity({ sizeBytes: -1, capacityBytes: 10 }),
    /sizeBytes/,
  );
  assert.throws(
    () => evaluateStorageCapacity({ sizeBytes: 1, capacityBytes: 10, warnRatio: 0 }),
    /warnRatio/,
  );
  assert.throws(
    () =>
      evaluateStorageCapacity({
        sizeBytes: 1,
        capacityBytes: 10,
        warnRatio: 0.9,
        criticalRatio: 0.5,
      }),
    /criticalRatio must not be below warnRatio/,
  );
});

test("time to capacity projects from observed growth and stays silent when flat", () => {
  const projection = projectTimeToCapacity({
    sizeBytes: 5 * GB,
    growthBytesPerDay: GB,
    capacityBytes: 10 * GB,
    now: NOW,
  });
  assert.equal(projection.daysRemaining, 5);
  assert.equal(projection.exhaustedAt, "2026-09-23T12:00:00.000Z");

  assert.deepEqual(
    projectTimeToCapacity({
      sizeBytes: 5 * GB,
      growthBytesPerDay: 0,
      capacityBytes: 10 * GB,
      now: NOW,
    }),
    { daysRemaining: null, exhaustedAt: null },
  );
  assert.deepEqual(
    projectTimeToCapacity({
      sizeBytes: 5 * GB,
      growthBytesPerDay: -GB,
      capacityBytes: 10 * GB,
      now: NOW,
    }),
    { daysRemaining: null, exhaustedAt: null },
  );

  // Already over: zero days, not a negative countdown.
  assert.equal(
    projectTimeToCapacity({
      sizeBytes: 12 * GB,
      growthBytesPerDay: GB,
      capacityBytes: 10 * GB,
      now: NOW,
    }).daysRemaining,
    0,
  );
});

test("the pragma probe reads a real size through the storage adapter", async (t) => {
  const { db } = createStorage(t);
  const sample = await probeDatabaseSize(db);

  assert.equal(sample.source, "pragma");
  assert.ok(sample.sizeBytes && sample.sizeBytes > 0);
  assert.ok(sample.pageSize && sample.pageCount);
  assert.equal(sample.sizeBytes, sample.pageCount! * sample.pageSize!);
  assert.equal(typeof sample.freelistBytes, "number");
});

test("a backend that refuses pragmas reports unavailable rather than throwing", async () => {
  // Cloudflare D1 answers `not authorized: SQLITE_AUTH [code: 7500]` here, so
  // this path is the norm on a hosted backend, not an error case.
  const refusing: StorageCapacitySqlExecutor = {
    prepare() {
      return {
        bind() {
          return this;
        },
        run: async () => ({}),
        all: async () => ({ results: [] }),
        first: async () => {
          throw new Error("not authorized: SQLITE_AUTH");
        },
      } as never;
    },
  };

  assert.deepEqual(await probeDatabaseSize(refusing), {
    sizeBytes: null,
    source: "unavailable",
  });
  assert.deepEqual(await resolveStorageSizeSample(refusing), {
    sizeBytes: null,
    source: "unavailable",
  });
  assert.deepEqual(await resolveStorageSizeSample(null), {
    sizeBytes: null,
    source: "unavailable",
  });
});

test("a caller-reported size takes precedence over the probe", async (t) => {
  const { db } = createStorage(t);

  const reported = await resolveStorageSizeSample(db, {
    sizeBytes: 5_931_641_856,
    freelistBytes: 1_024,
  });
  assert.equal(reported.source, "reported");
  assert.equal(reported.sizeBytes, 5_931_641_856);
  assert.equal(reported.freelistBytes, 1_024);

  // Only an absent reported size falls through to the probe.
  assert.equal((await resolveStorageSizeSample(db, {})).source, "pragma");
});

test("table footprint names the tables driving growth", async (t) => {
  const { storage, db } = createStorage(t);

  for (let index = 0; index < 5; index += 1) {
    await storage.DB.prepare(
      `
        INSERT INTO identities (
          id, data, name, org_id, workspace_id, sponsor_id,
          created_at, updated_at
        )
        VALUES (?, '{}', ?, 'org_x', 'ws_x', 'user_x', ?, ?)
      `,
    )
      .bind(`agent_${index}`, `agent_${index}`, NOW.toISOString(), NOW.toISOString())
      .run();
  }

  const footprint = await collectTableFootprint(db, [
    "tokens",
    "identities",
    "audit_logs",
    "table_that_does_not_exist",
  ]);

  assert.deepEqual(footprint[0], { table: "identities", rowCount: 5 });
  assert.ok(!footprint.some((entry) => entry.table === "table_that_does_not_exist"));

  await assert.rejects(
    () => collectTableFootprint(db, ["identities; DROP TABLE identities"]),
    /bare SQL identifier/,
  );
  // The injection attempt was refused, not executed.
  const survived = await collectTableFootprint(db, ["identities"]);
  assert.deepEqual(survived, [{ table: "identities", rowCount: 5 }]);
});

test("the capacity sample round-trips through storage and overwrites in place", async (t) => {
  const { db } = createStorage(t);

  assert.equal(await readStorageCapacitySample(db), null);

  await recordStorageCapacitySample(db, {
    sizeBytes: 5 * GB,
    capacityBytes: 10 * GB,
    freelistBytes: GB,
    now: NOW,
  });
  assert.deepEqual(await readStorageCapacitySample(db), {
    sizeBytes: 5 * GB,
    capacityBytes: 10 * GB,
    freelistBytes: GB,
    observedAt: NOW.toISOString(),
  });

  const later = new Date(NOW.getTime() + 60_000);
  await recordStorageCapacitySample(db, { sizeBytes: 6 * GB, now: later });
  assert.deepEqual(await readStorageCapacitySample(db), {
    sizeBytes: 6 * GB,
    observedAt: later.toISOString(),
  });
});

test("the gauge caches within its TTL and refreshes after it", async (t) => {
  const { db } = createStorage(t);
  await recordStorageCapacitySample(db, { sizeBytes: 5 * GB, now: NOW });

  let reads = 0;
  const counting: StorageCapacitySqlExecutor = {
    prepare(sql: string) {
      reads += 1;
      return (db as StorageCapacitySqlExecutor).prepare(sql);
    },
  };

  const gauge = new StorageCapacityGauge(30_000);
  assert.equal((await gauge.read(counting, { now: NOW }))?.sizeBytes, 5 * GB);
  assert.equal(reads, 1);

  await recordStorageCapacitySample(db, { sizeBytes: 9 * GB, now: NOW });
  assert.equal(
    (await gauge.read(counting, { now: new Date(NOW.getTime() + 29_000) }))?.sizeBytes,
    5 * GB,
    "still serving the cached sample",
  );
  assert.equal(reads, 1);

  assert.equal(
    (await gauge.read(counting, { now: new Date(NOW.getTime() + 31_000) }))?.sizeBytes,
    9 * GB,
  );
  assert.equal(reads, 2);
});

test("a gauge read that throws yields no sample instead of failing the caller", async (t) => {
  const failing: StorageCapacitySqlExecutor = {
    prepare() {
      throw new Error("storage unavailable");
    },
  };

  const gauge = new StorageCapacityGauge(0);
  assert.equal(await gauge.read(failing, { now: NOW }), null);
  void t;
});

test("shedding stays off unless explicitly configured", () => {
  const critical = {
    sizeBytes: 10 * GB,
    capacityBytes: 10 * GB,
    observedAt: NOW.toISOString(),
  };
  const offSettings = resolveStorageCapacitySettings({});

  assert.deepEqual(
    shouldShedForStorageCapacity({ sample: critical, settings: offSettings, now: NOW }),
    { shed: false, reason: "shedding_disabled" },
  );

  // Configured to shed, but with no ceiling to measure against.
  assert.equal(
    shouldShedForStorageCapacity({
      sample: { sizeBytes: 10 * GB, observedAt: NOW.toISOString() },
      settings: { warnRatio: 0.7, criticalRatio: 0.85, shedRatio: 0.9 },
      now: NOW,
    }).reason,
    "capacity_unset",
  );

  // Configured, but nothing has sampled the database yet.
  assert.equal(
    shouldShedForStorageCapacity({
      sample: null,
      settings: {
        capacityBytes: 10 * GB,
        warnRatio: 0.7,
        criticalRatio: 0.85,
        shedRatio: 0.9,
      },
      now: NOW,
    }).reason,
    "no_sample",
  );
});

test("shedding trips above its ratio and fails open on a stale sample", () => {
  const settings = {
    capacityBytes: 10 * GB,
    warnRatio: 0.7,
    criticalRatio: 0.85,
    shedRatio: 0.9,
  };

  assert.equal(
    shouldShedForStorageCapacity({
      sample: { sizeBytes: 8 * GB, observedAt: NOW.toISOString() },
      settings,
      now: NOW,
    }).shed,
    false,
  );
  assert.equal(
    shouldShedForStorageCapacity({
      sample: { sizeBytes: 9.5 * GB, observedAt: NOW.toISOString() },
      settings,
      now: NOW,
    }).shed,
    true,
  );

  // A database at its high-water mark but mostly freelist can absorb writes
  // without growing, so it is not a reason to reject creates.
  assert.equal(
    shouldShedForStorageCapacity({
      sample: { sizeBytes: 9.5 * GB, freelistBytes: 6 * GB, observedAt: NOW.toISOString() },
      settings,
      now: NOW,
    }).shed,
    false,
  );

  // Nobody is sampling; that is not evidence the database is full.
  const stale = shouldShedForStorageCapacity({
    sample: {
      sizeBytes: 9.5 * GB,
      observedAt: new Date(
        NOW.getTime() - DEFAULT_STORAGE_CAPACITY_SAMPLE_MAX_AGE_MS - 1_000,
      ).toISOString(),
    },
    settings,
    now: NOW,
  });
  assert.deepEqual(stale, { shed: false, reason: "sample_stale" });

  assert.deepEqual(
    shouldShedForStorageCapacity({
      sample: { sizeBytes: 9.5 * GB, observedAt: "not-a-timestamp" },
      settings,
      now: NOW,
    }),
    { shed: false, reason: "sample_unreadable" },
  );
});

test("capacity bindings default safely and clamp malformed values", (t) => {
  const captured = captureConsole(t);

  const defaults = resolveStorageCapacitySettings({});
  assert.deepEqual(defaults, {
    warnRatio: DEFAULT_STORAGE_CAPACITY_WARN_RATIO,
    criticalRatio: DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO,
  });
  assert.equal(defaults.capacityBytes, undefined, "the guardrail is off by default");
  assert.equal(defaults.shedRatio, undefined, "shedding is off by default");

  const configured = resolveStorageCapacitySettings({
    RELAYAUTH_STORAGE_CAPACITY_BYTES: "10737418240",
    RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO: "0.6",
    RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO: "0.8",
    RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO: "0.95",
  });
  assert.deepEqual(configured, {
    capacityBytes: 10 * GB,
    warnRatio: 0.6,
    criticalRatio: 0.8,
    shedRatio: 0.95,
  });

  // Malformed values leave the guardrail off rather than guessing a ceiling.
  const malformed = resolveStorageCapacitySettings({
    RELAYAUTH_STORAGE_CAPACITY_BYTES: "10 GB",
    RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO: "seventy percent",
    RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO: "1.5",
    RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO: "-1",
  });
  assert.deepEqual(malformed, {
    warnRatio: DEFAULT_STORAGE_CAPACITY_WARN_RATIO,
    criticalRatio: DEFAULT_STORAGE_CAPACITY_CRITICAL_RATIO,
  });
  assert.equal(captured.warn.length, 4, "each rejected binding is reported");

  // An inverted pair would make `critical` unreachable and quietly downgrade
  // every alert to `warn`.
  assert.deepEqual(
    resolveStorageCapacitySettings({
      RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO: "0.9",
      RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO: "0.5",
    }),
    { warnRatio: 0.9, criticalRatio: 0.9 },
  );

  // Empty strings are "unset", which is how an absent binding arrives on some
  // runtimes.
  assert.equal(
    resolveStorageCapacitySettings({ RELAYAUTH_STORAGE_CAPACITY_BYTES: "  " })
      .capacityBytes,
    undefined,
  );
});

test("capacity logging is silent when healthy and escalates at critical", (t) => {
  const captured = captureConsole(t);

  logStorageCapacity(evaluateStorageCapacity({ sizeBytes: GB, capacityBytes: 10 * GB }));
  assert.equal(captured.warn.length, 0);
  assert.equal(captured.error.length, 0);

  logStorageCapacity(
    evaluateStorageCapacity({ sizeBytes: 7.5 * GB, capacityBytes: 10 * GB }),
    { via: "sweep" },
  );
  assert.equal(captured.warn.length, 1);
  assert.equal(captured.warn[0][0], "relayauth.storage.capacity");
  assert.deepEqual(
    (captured.warn[0][1] as Record<string, unknown>).event,
    "relayauth.storage.capacity",
  );
  assert.equal((captured.warn[0][1] as Record<string, unknown>).level, "warn");
  assert.equal((captured.warn[0][1] as Record<string, unknown>).via, "sweep");

  logStorageCapacity(
    evaluateStorageCapacity({ sizeBytes: 9.5 * GB, capacityBytes: 10 * GB }),
  );
  assert.equal(captured.error.length, 1);
  assert.equal((captured.error[0][1] as Record<string, unknown>).level, "critical");
});

test("only an executor-shaped value is accepted as a SQL executor", (t) => {
  const { storage } = createStorage(t);

  assert.ok(asStorageCapacitySqlExecutor(storage.DB));
  assert.equal(asStorageCapacitySqlExecutor(undefined), null);
  assert.equal(asStorageCapacitySqlExecutor(null), null);
  assert.equal(asStorageCapacitySqlExecutor({}), null);
  assert.equal(asStorageCapacitySqlExecutor({ prepare: "not a function" }), null);
});
