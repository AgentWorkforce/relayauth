import type { Context } from "hono";

import type { AppEnv } from "../env.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 100;
const DEFAULT_JITTER_RATIO = 0.2;

export const STORAGE_OVERLOAD_RETRY_AFTER_SECONDS = 1;

// Capacity exhaustion only clears once retention reclaims space, so callers
// must back off far longer than they do for a transient overload.
export const STORAGE_CAPACITY_RETRY_AFTER_SECONDS = 30;

export type StorageRetryOptions = {
  operation: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
};

export class StorageOverloadedError extends Error {
  readonly code = "storage_overloaded";
  readonly retryable = true;
  readonly status = 503;
  readonly retryAfterSeconds = STORAGE_OVERLOAD_RETRY_AFTER_SECONDS;

  constructor(
    readonly operation: string,
    readonly attempts: number,
    options: { cause?: unknown } = {},
  ) {
    super("Storage is temporarily overloaded", { cause: options.cause });
    this.name = "StorageOverloadedError";
  }
}

export class StorageCapacityExhaustedError extends Error {
  readonly code = "storage_capacity_exhausted";
  readonly retryable = true;
  readonly status = 503;
  readonly retryAfterSeconds = STORAGE_CAPACITY_RETRY_AFTER_SECONDS;

  constructor(
    readonly operation: string,
    options: { cause?: unknown } = {},
  ) {
    super("Storage is at capacity", { cause: options.cause });
    this.name = "StorageCapacityExhaustedError";
  }
}

/**
 * Matches the write rejection a backing store raises once it can no longer
 * allocate: D1 past its database size limit, or SQLite's SQLITE_FULL.
 *
 * Unlike an overload this is not cleared by retrying in-request — the space
 * has to come back from retention — so it is classified separately and
 * surfaced immediately.
 */
export function isStorageCapacityExhausted(error: unknown): boolean {
  if (error instanceof StorageCapacityExhaustedError) {
    return true;
  }

  const message = collectErrorMessages(error).join(" ");
  return (
    /\bexceeded\s+maximum\s+db\s+size\b/i.test(message)
    || /\bSQLITE_FULL\b/i.test(message)
    || /\b(?:database|disk)\b[^.]{0,24}\bis\s+full\b/i.test(message)
  );
}

export function isStorageCapacityExhaustedError(
  error: unknown,
): error is StorageCapacityExhaustedError {
  return error instanceof StorageCapacityExhaustedError;
}

export function toStorageCapacityExhaustedError(
  error: unknown,
  operation: string,
): StorageCapacityExhaustedError {
  return isStorageCapacityExhaustedError(error)
    ? error
    : new StorageCapacityExhaustedError(operation, { cause: error });
}

export function isTransientStorageOverload(error: unknown): boolean {
  const message = collectErrorMessages(error).join(" ");
  return (
    /\b(?:database|db|storage)\b.{0,24}\boverload(?:ed)?\b/i.test(message)
    || /\brequests?\s+queued\b/i.test(message)
    || /\bqueue(?:d)?\b.{0,24}\btoo\s+long\b/i.test(message)
    || /\btoo\s+many\s+(?:concurrent\s+)?requests\b/i.test(message)
    || /\bSQLITE_BUSY(?:_\w+)?\b/i.test(message)
    || /\bdatabase\s+(?:is\s+)?locked\b/i.test(message)
  );
}

export function isStorageOverloadedError(error: unknown): error is StorageOverloadedError {
  return error instanceof StorageOverloadedError;
}

export async function withStorageRetry<T>(
  task: () => Promise<T>,
  options: StorageRetryOptions,
): Promise<T> {
  const maxAttempts = normalizePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = normalizeNonNegativeNumber(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = normalizeNonNegativeNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const jitterRatio = Math.min(1, normalizeNonNegativeNumber(options.jitterRatio, DEFAULT_JITTER_RATIO));
  const sleep = options.sleep ?? delay;
  const random = options.random ?? Math.random;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      if (isStorageCapacityExhausted(error)) {
        throw toStorageCapacityExhaustedError(error, options.operation);
      }

      if (!isTransientStorageOverload(error)) {
        throw error;
      }

      if (attempt === maxAttempts) {
        throw new StorageOverloadedError(options.operation, attempt, { cause: error });
      }

      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const jitterMultiplier = 1 + ((random() * 2) - 1) * jitterRatio;
      await sleep(Math.max(0, Math.round(exponentialDelay * jitterMultiplier)));
    }
  }
}

export function storageOverloadResponse(
  c: Context<AppEnv>,
  error: StorageOverloadedError,
): Response {
  const requestId = c.get("requestId") || c.req.header("x-request-id") || "unknown";
  c.header("Retry-After", String(error.retryAfterSeconds));
  c.header("Cache-Control", "no-store");

  console.error("RelayAuth storage overloaded", {
    requestId,
    operation: error.operation,
    attempts: error.attempts,
    cause: error.cause instanceof Error ? error.cause.message : String(error.cause ?? "unknown"),
  });

  return c.json({
    error: "Storage is temporarily overloaded",
    code: error.code,
    retryable: true,
    operation: error.operation,
    attempts: error.attempts,
    requestId,
  }, 503);
}

export function storageCapacityResponse(
  c: Context<AppEnv>,
  error: StorageCapacityExhaustedError,
): Response {
  const requestId = c.get("requestId") || c.req.header("x-request-id") || "unknown";
  c.header("Retry-After", String(error.retryAfterSeconds));
  c.header("Cache-Control", "no-store");

  console.error("RelayAuth storage capacity exhausted", {
    requestId,
    operation: error.operation,
    cause: error.cause instanceof Error ? error.cause.message : String(error.cause ?? "unknown"),
  });

  return c.json({
    error: "Storage is at capacity",
    code: error.code,
    retryable: true,
    operation: error.operation,
    requestId,
  }, 503);
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string") {
        messages.push(code);
      }
      current = current.cause;
      continue;
    }

    messages.push(String(current));
    break;
  }

  return messages;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
