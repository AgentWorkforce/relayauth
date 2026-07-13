import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientStorageOverload,
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
