export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

export interface RequestRateLimiter {
  consume(keys: string[], now?: number): RateLimitDecision;
}

export class RateLimitExceededError extends Error {
  constructor(readonly decision: RateLimitDecision) {
    super("Request rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

export function isRateLimitExceededError(error: unknown): error is RateLimitExceededError {
  return error instanceof RateLimitExceededError;
}

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export class FixedWindowRateLimiter implements RequestRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("rate-limit limit must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs < 1) {
      throw new Error("rate-limit windowMs must be positive");
    }
  }

  consume(keys: string[], now = Date.now()): RateLimitDecision {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    const activeEntries = uniqueKeys.map((key) => ({
      key,
      entry: this.getActiveEntry(key, now),
    }));
    const blocked = activeEntries.find(({ entry }) => entry.count >= this.limit);

    if (blocked) {
      return this.decision(false, blocked.entry, now);
    }

    let mostConsumed: RateLimitEntry | undefined;
    for (const { key, entry } of activeEntries) {
      entry.count += 1;
      this.entries.set(key, entry);
      if (!mostConsumed || entry.count > mostConsumed.count) {
        mostConsumed = entry;
      }
    }

    this.pruneIfNeeded(now);
    return this.decision(true, mostConsumed ?? { count: 1, resetAt: now + this.windowMs }, now);
  }

  private getActiveEntry(key: string, now: number): RateLimitEntry {
    const existing = this.entries.get(key);
    if (existing && now < existing.resetAt) {
      return existing;
    }

    return { count: 0, resetAt: now + this.windowMs };
  }

  private decision(allowed: boolean, entry: RateLimitEntry, now: number): RateLimitDecision {
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  private pruneIfNeeded(now: number): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }
}
