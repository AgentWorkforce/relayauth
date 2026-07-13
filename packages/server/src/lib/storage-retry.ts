import type { Context } from "hono";

import type { AppEnv } from "../env.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 100;
const DEFAULT_JITTER_RATIO = 0.2;

export const STORAGE_OVERLOAD_RETRY_AFTER_SECONDS = 1;

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

export function isTransientStorageOverload(error: unknown): boolean {
  const message = collectErrorMessages(error).join(" ");
  return (
    /\b(?:database|db|storage)\b.{0,24}\boverload(?:ed)?\b/i.test(message)
    || /\brequests?\s+queued\b/i.test(message)
    || /\bqueue(?:d)?\b.{0,24}\btoo\s+long\b/i.test(message)
    || /\btoo\s+many\s+(?:concurrent\s+)?requests\b/i.test(message)
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
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

  throw new StorageOverloadedError(options.operation, maxAttempts);
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
