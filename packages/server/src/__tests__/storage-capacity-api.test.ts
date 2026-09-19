import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  recordStorageCapacitySample,
  sharedStorageCapacityGauge,
  type StorageCapacitySqlExecutor,
} from "../engine/storage-capacity.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

const GB = 1_024 ** 3;

type StorageStatsResponse = {
  sizeBytes: number | null;
  source: string;
  capacityConfigured: boolean;
  sheddingEnabled: boolean;
  level?: string;
  capacityBytes?: number;
  usedRatio?: number;
  effectiveUsedRatio?: number;
  headroomBytes?: number;
  reclaimableBytes?: number;
  warnRatio?: number;
  criticalRatio?: number;
  freelistBytes?: number;
  observedAt?: string;
  tables?: { table: string; rowCount: number }[];
};

type CapacityBindings = {
  RELAYAUTH_STORAGE_CAPACITY_BYTES?: string;
  RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO?: string;
  RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO?: string;
  RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO?: string;
};

function createApp(t: TestContext, bindings: CapacityBindings = {}) {
  const app = createTestApp(bindings);
  // The gauge is deliberately module-scope (per isolate), so a test that
  // primes it would otherwise leak into the next one.
  sharedStorageCapacityGauge.reset();
  t.after(async () => {
    sharedStorageCapacityGauge.reset();
    await app.close();
  });
  return app;
}

function authorize(scopes: string[]): Record<string, string> {
  return {
    Authorization: `Bearer ${generateTestToken({
      org: "org_capacity",
      wks: "ws_capacity",
      workspace_id: "ws_capacity",
      scopes,
    })}`,
  };
}

test("GET /v1/stats/storage requires the stats read scope", async (t) => {
  const app = createApp(t);

  const denied = await app.request(
    createTestRequest("GET", "/v1/stats/storage", undefined, authorize(["relayauth:identity:read"])),
    undefined,
    app.bindings,
  );
  assert.equal(denied.status, 403);

  const anonymous = await app.request(
    createTestRequest("GET", "/v1/stats/storage"),
    undefined,
    app.bindings,
  );
  assert.ok(anonymous.status === 401 || anonymous.status === 403);

  const allowed = await app.request(
    createTestRequest("GET", "/v1/stats/storage", undefined, authorize(["relayauth:stats:read"])),
    undefined,
    app.bindings,
  );
  assert.equal(allowed.status, 200);
});

test("GET /v1/stats/storage reports size without a level until a ceiling is set", async (t) => {
  const app = createApp(t);

  const response = await app.request(
    createTestRequest("GET", "/v1/stats/storage", undefined, authorize(["relayauth:stats:read"])),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<StorageStatsResponse>(response, 200);

  assert.equal(body.source, "pragma");
  assert.ok((body.sizeBytes ?? 0) > 0);
  assert.equal(body.capacityConfigured, false);
  assert.equal(body.sheddingEnabled, false);
  assert.equal(body.level, undefined, "no ceiling means nothing to grade against");
  assert.ok(body.tables?.some((entry) => entry.table === "identities"));
});

test("GET /v1/stats/storage grades against a configured ceiling", async (t) => {
  const app = createApp(t, {
    // A ceiling just above the empty test database, so the assessment is a real
    // computation rather than a rounding artifact.
    RELAYAUTH_STORAGE_CAPACITY_BYTES: "1000000",
    RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO: "0.1",
    RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO: "0.2",
  });

  const response = await app.request(
    createTestRequest("GET", "/v1/stats/storage", undefined, authorize(["relayauth:stats:read"])),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<StorageStatsResponse>(response, 200);

  assert.equal(body.capacityConfigured, true);
  assert.equal(body.capacityBytes, 1_000_000);
  assert.equal(body.level, "critical");
  assert.equal(body.warnRatio, 0.1);
  assert.equal(body.criticalRatio, 0.2);
  assert.ok((body.usedRatio ?? 0) > 0.2);
  assert.equal(typeof body.headroomBytes, "number");
  assert.equal(typeof body.reclaimableBytes, "number");
});

test("GET /v1/stats/storage prefers a recorded sample over its own probe", async (t) => {
  const app = createApp(t, { RELAYAUTH_STORAGE_CAPACITY_BYTES: String(10 * GB) });
  const db = app.storage.DB as unknown as StorageCapacitySqlExecutor;

  // This is the hosted shape: the size came from write metadata the platform
  // reported, not from a pragma this process could run.
  await recordStorageCapacitySample(db, {
    sizeBytes: 5_931_641_856,
    freelistBytes: 2 * GB,
    now: new Date("2026-09-18T12:00:00.000Z"),
  });

  const response = await app.request(
    createTestRequest("GET", "/v1/stats/storage", undefined, authorize(["relayauth:stats:read"])),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<StorageStatsResponse>(response, 200);

  assert.equal(body.source, "reported");
  assert.equal(body.sizeBytes, 5_931_641_856);
  assert.equal(body.freelistBytes, 2 * GB);
  assert.equal(body.observedAt, "2026-09-18T12:00:00.000Z");
  assert.equal(body.level, "ok");
  assert.ok(
    (body.effectiveUsedRatio ?? 1) < (body.usedRatio ?? 0),
    "freelist headroom is discounted from the effective ratio",
  );
});

async function createIdentity(
  app: ReturnType<typeof createTestApp>,
  name: string,
): Promise<Response> {
  return app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name, sponsorId: "user_capacity" },
      authorize(["relayauth:identity:manage:*"]),
    ),
    undefined,
    app.bindings,
  );
}

test("identity create does not shed while shedding is unconfigured", async (t) => {
  const app = createApp(t, { RELAYAUTH_STORAGE_CAPACITY_BYTES: String(10 * GB) });
  await recordStorageCapacitySample(
    app.storage.DB as unknown as StorageCapacitySqlExecutor,
    { sizeBytes: 10 * GB },
  );

  const response = await createIdentity(app, "agent-no-shedding");
  assert.equal(response.status, 201);
});

test("identity create sheds with a retryable envelope once configured and over the ratio", async (t) => {
  const app = createApp(t, {
    RELAYAUTH_STORAGE_CAPACITY_BYTES: String(10 * GB),
    RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO: "0.9",
  });
  await recordStorageCapacitySample(
    app.storage.DB as unknown as StorageCapacitySqlExecutor,
    { sizeBytes: 9.5 * GB },
  );

  const response = await createIdentity(app, "agent-shed");
  const body = await assertJsonResponse<{
    error: string;
    code: string;
    retryable: boolean;
    operation: string;
  }>(response, 503);

  assert.equal(body.code, "storage_capacity_exhausted");
  assert.equal(body.retryable, true);
  assert.equal(body.operation, "identities.create");
  assert.equal(response.headers.get("Retry-After"), "30");

  // Nothing was written, so a caller that retries after the wait is not
  // duplicating a committed identity.
  const stored = await app.storage.DB.prepare(
    "SELECT COUNT(*) AS count FROM identities",
  ).first<{ count: number }>();
  assert.equal(Number(stored?.count), 0);
});

test("identity create stays open below the shed ratio and on a stale sample", async (t) => {
  const belowRatio = createApp(t, {
    RELAYAUTH_STORAGE_CAPACITY_BYTES: String(10 * GB),
    RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO: "0.9",
  });
  await recordStorageCapacitySample(
    belowRatio.storage.DB as unknown as StorageCapacitySqlExecutor,
    { sizeBytes: 5 * GB },
  );
  assert.equal((await createIdentity(belowRatio, "agent-headroom")).status, 201);

  sharedStorageCapacityGauge.reset();

  // Nobody has sampled recently. That is not evidence the database is full, so
  // the guardrail must not reject live traffic on it.
  const stale = createApp(t, {
    RELAYAUTH_STORAGE_CAPACITY_BYTES: String(10 * GB),
    RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO: "0.9",
  });
  await recordStorageCapacitySample(
    stale.storage.DB as unknown as StorageCapacitySqlExecutor,
    { sizeBytes: 10 * GB, now: new Date(Date.now() - 24 * 60 * 60 * 1_000) },
  );
  assert.equal((await createIdentity(stale, "agent-stale-sample")).status, 201);
});

test("identity create stays open when no capacity sample has ever been taken", async (t) => {
  const app = createApp(t, {
    RELAYAUTH_STORAGE_CAPACITY_BYTES: String(10 * GB),
    RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO: "0.9",
  });

  assert.equal((await createIdentity(app, "agent-unsampled")).status, 201);
});
