import assert from "node:assert/strict";
import test from "node:test";

import {
  isStorageCapacityExhausted,
  isTransientStorageOverload,
  StorageCapacityExhaustedError,
  StorageOverloadedError,
  withStorageRetry,
} from "../lib/storage-retry.js";

test("withStorageRetry uses bounded exponential backoff and returns a recovered value", async () => {
  const delays: number[] = [];
  let attempts = 0;

  const result = await withStorageRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error("DB is overloaded. Requests queued for too long.");
    }
    return "recovered";
  }, {
    operation: "test.read",
    jitterRatio: 0,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(result, "recovered");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);
});

test("withStorageRetry wraps exhausted overloads without retrying unrelated failures", async () => {
  let overloadedAttempts = 0;
  await assert.rejects(
    withStorageRetry(async () => {
      overloadedAttempts += 1;
      throw new Error("database overloaded");
    }, {
      operation: "test.exhausted",
      sleep: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof StorageOverloadedError);
      assert.equal(error.operation, "test.exhausted");
      assert.equal(error.attempts, 3);
      return true;
    },
  );
  assert.equal(overloadedAttempts, 3);

  let unrelatedAttempts = 0;
  await assert.rejects(
    withStorageRetry(async () => {
      unrelatedAttempts += 1;
      throw new Error("constraint failed");
    }, {
      operation: "test.unrelated",
      sleep: async () => undefined,
    }),
    /constraint failed/,
  );
  assert.equal(unrelatedAttempts, 1);
});

test("isTransientStorageOverload recognizes nested queue-capacity failures", () => {
  const error = new Error("adapter request failed", {
    cause: new Error("Requests queued for too long because DB is overloaded"),
  });
  assert.equal(isTransientStorageOverload(error), true);
  assert.equal(isTransientStorageOverload(new Error("identity_already_exists")), false);
});

test("isTransientStorageOverload recognizes SQLite busy codes and lock messages", () => {
  const busy = Object.assign(new Error("database write failed"), { code: "SQLITE_BUSY" });

  assert.equal(isTransientStorageOverload(busy), true);
  assert.equal(isTransientStorageOverload(new Error("database is locked")), true);
  assert.equal(isTransientStorageOverload(new Error("SQLITE_CONSTRAINT")), false);
});

test("isStorageCapacityExhausted recognizes this runtime's SQLite size-limit rejections", () => {
  assert.equal(isStorageCapacityExhausted(new Error("database or disk is full")), true);
  assert.equal(
    isStorageCapacityExhausted(Object.assign(new Error("write failed"), { code: "SQLITE_FULL" })),
    true,
  );
  assert.equal(
    isStorageCapacityExhausted(new Error("mint failed", {
      cause: new Error("database or disk is full"),
    })),
    true,
  );

  assert.equal(isStorageCapacityExhausted(new Error("database is locked")), false);
  assert.equal(isStorageCapacityExhausted(new Error("SQLITE_CONSTRAINT")), false);
  assert.equal(isStorageCapacityExhausted(new Error("identity_already_exists")), false);
});

test("isStorageCapacityExhausted carries a hosted adapter's translated error", () => {
  assert.equal(
    isStorageCapacityExhausted(new StorageCapacityExhaustedError("tokens.persist")),
    true,
  );

  // Provider wording is the adapter's to recognize — this package stays
  // platform-agnostic (AGENTS.md "No Cloudflare dependencies in @relayauth/*").
  assert.equal(
    isStorageCapacityExhausted(new Error("PROVIDER_ERROR: Exceeded maximum DB size")),
    false,
  );
});

test("withStorageRetry surfaces capacity exhaustion immediately instead of retrying", async () => {
  let attempts = 0;

  await assert.rejects(
    withStorageRetry(async () => {
      attempts += 1;
      throw new Error("database or disk is full");
    }, {
      operation: "test.capacity",
      sleep: async () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof StorageCapacityExhaustedError);
      assert.equal(error.operation, "test.capacity");
      assert.equal(error.code, "storage_capacity_exhausted");
      assert.equal(error.status, 503);
      return true;
    },
  );

  assert.equal(attempts, 1, "space cannot come back within a retry window");
});
