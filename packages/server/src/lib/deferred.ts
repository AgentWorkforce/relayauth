import type { Context } from "hono";

import type { AppEnv } from "../env.js";

export type DeferredTask = () => Promise<unknown>;

export type DeferredTaskScheduler = (task: DeferredTask) => void;

export type DeferredTaskFailure = {
  operation: string;
  error: unknown;
};

export type DeferredTaskFailureHandler = (
  failure: DeferredTaskFailure,
) => void | Promise<void>;

export function resolveDeferredTaskScheduler(
  c: Context<AppEnv>,
  configured?: DeferredTaskScheduler,
): DeferredTaskScheduler {
  if (configured) {
    return configured;
  }

  try {
    const executionContext = c.executionCtx;
    return (task) => executionContext.waitUntil(runAfterCurrentTurn(task));
  } catch {
    // Node's request lifecycle has no execution context. A macrotask boundary
    // keeps best-effort work off the foreground request path while still
    // allowing the process to drain it.
    return (task) => {
      void runAfterCurrentTurn(task);
    };
  }
}

export function scheduleDeferredTask(
  scheduler: DeferredTaskScheduler,
  operation: string,
  task: () => Promise<unknown>,
  onFailure?: DeferredTaskFailureHandler,
): void {
  const guardedTask: DeferredTask = async () => {
    try {
      await task();
    } catch (error) {
      if (onFailure) {
        try {
          await onFailure({ operation, error });
        } catch (handlerError) {
          console.error("Deferred task failure handler threw an error", {
            operation,
            error: handlerError instanceof Error ? handlerError.message : String(handlerError),
          });
        }
        return;
      }

      console.error("Deferred RelayAuth task failed", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    scheduler(guardedTask);
  } catch (error) {
    // A lifecycle scheduler must never be able to fail the foreground
    // request. Fall back to the platform-neutral next-turn scheduler.
    console.error("Failed to register deferred RelayAuth task", {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    void runAfterCurrentTurn(guardedTask);
  }
}

function runAfterCurrentTurn(task: DeferredTask): Promise<unknown> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  }).then(task);
}
