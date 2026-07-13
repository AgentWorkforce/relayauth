import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "hono";

import type { AppEnv } from "../env.js";
import {
  type DeferredTask,
  resolveDeferredTaskScheduler,
  scheduleDeferredTask,
} from "../lib/deferred.js";

test("scheduleDeferredTask registers a thunk without starting work eagerly", async () => {
  const deferred: DeferredTask[] = [];
  let started = false;

  scheduleDeferredTask(
    (task) => deferred.push(task),
    "test.deferred",
    async () => {
      started = true;
    },
  );

  assert.equal(started, false);
  assert.equal(deferred.length, 1);
  await deferred[0]?.();
  assert.equal(started, true);
});

test("scheduleDeferredTask isolates failures thrown by its failure handler", async () => {
  const deferred: DeferredTask[] = [];
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    scheduleDeferredTask(
      (task) => deferred.push(task),
      "test.failure-handler",
      async () => {
        throw new Error("task failed");
      },
      async () => {
        throw new Error("handler failed");
      },
    );

    await assert.doesNotReject(deferred[0]?.());
    assert.ok(logged.some((args) => String(args[0]).includes("failure handler threw")));
  } finally {
    console.error = originalConsoleError;
  }
});

test("the Node fallback scheduler starts work on the next macrotask", async () => {
  const context = {
    get executionCtx(): never {
      throw new Error("execution context unavailable");
    },
  } as Context<AppEnv>;
  const scheduler = resolveDeferredTaskScheduler(context);
  let started = false;

  scheduler(async () => {
    started = true;
  });

  assert.equal(started, false);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(started, true);
});
