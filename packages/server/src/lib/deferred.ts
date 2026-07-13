import type { Context } from "hono";

import type { AppEnv } from "../env.js";

export type DeferredTaskScheduler = (task: Promise<unknown>) => void;

export type DeferredTaskFailure = {
  operation: string;
  error: unknown;
};

export function resolveDeferredTaskScheduler(
  c: Context<AppEnv>,
  configured?: DeferredTaskScheduler,
): DeferredTaskScheduler {
  if (configured) {
    return configured;
  }

  try {
    const executionContext = c.executionCtx;
    return (task) => executionContext.waitUntil(task);
  } catch {
    // Node's request lifecycle has no execution context. Starting the guarded
    // promise without awaiting it keeps request latency independent of the
    // best-effort background work while still allowing Node to drain it.
    return (task) => {
      void task;
    };
  }
}

export function scheduleDeferredTask(
  scheduler: DeferredTaskScheduler,
  operation: string,
  task: () => Promise<unknown>,
  onFailure?: (failure: DeferredTaskFailure) => void,
): void {
  const guardedTask = Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      if (onFailure) {
        onFailure({ operation, error });
        return;
      }

      console.error("Deferred RelayAuth task failed", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  try {
    scheduler(guardedTask);
  } catch (error) {
    // A lifecycle scheduler must never be able to fail the foreground
    // request. The guarded task has already started, so let it drain.
    console.error("Failed to register deferred RelayAuth task", {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    void guardedTask;
  }
}
