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

type RateLimitExpiry = {
  key: string;
  resetAt: number;
};

export class FixedWindowRateLimiter implements RequestRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly expiries: RateLimitExpiry[] = [];

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
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("rate-limit maxEntries must be a positive integer");
    }
  }

  consume(keys: string[], now = Date.now()): RateLimitDecision {
    this.pruneExpired(now);
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    const activeEntries = uniqueKeys.map((key) => ({
      key,
      entry: this.entries.get(key),
    }));
    const blocked = activeEntries.find(({ entry }) => entry && entry.count >= this.limit);

    if (blocked?.entry) {
      return this.decision(false, blocked.entry, now);
    }

    const newEntryCount = activeEntries.reduce(
      (count, { entry }) => count + (entry ? 0 : 1),
      0,
    );
    if (this.entries.size + newEntryCount > this.maxEntries) {
      // Never evict an active bucket: doing so resets its counter and lets an
      // attacker bypass throttling by flooding the limiter with distinct keys.
      // Reject new admissions until the earliest active window expires.
      return this.decision(false, {
        count: this.limit,
        resetAt: this.expiries[0]?.resetAt ?? now + this.windowMs,
      }, now);
    }

    let mostConsumed: RateLimitEntry | undefined;
    for (const { key, entry: existing } of activeEntries) {
      const entry = existing ?? { count: 0, resetAt: now + this.windowMs };
      entry.count += 1;
      if (!existing) {
        this.entries.set(key, entry);
        this.pushExpiry({ key, resetAt: entry.resetAt });
      }
      if (!mostConsumed || entry.count > mostConsumed.count) {
        mostConsumed = entry;
      }
    }

    return this.decision(true, mostConsumed ?? { count: 1, resetAt: now + this.windowMs }, now);
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

  private pruneExpired(now: number): void {
    while (this.expiries[0] && now >= this.expiries[0].resetAt) {
      const expired = this.popExpiry();
      if (!expired) {
        return;
      }

      const entry = this.entries.get(expired.key);
      if (entry?.resetAt === expired.resetAt) {
        this.entries.delete(expired.key);
      }
    }
  }

  private pushExpiry(expiry: RateLimitExpiry): void {
    this.expiries.push(expiry);
    let index = this.expiries.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.expiries[parentIndex];
      if (!parent || parent.resetAt <= expiry.resetAt) {
        break;
      }
      this.expiries[index] = parent;
      index = parentIndex;
    }
    this.expiries[index] = expiry;
  }

  private popExpiry(): RateLimitExpiry | undefined {
    const first = this.expiries[0];
    const last = this.expiries.pop();
    if (!first || !last || this.expiries.length === 0) {
      return first;
    }

    let index = 0;
    while (true) {
      const leftIndex = (index * 2) + 1;
      const rightIndex = leftIndex + 1;
      const left = this.expiries[leftIndex];
      const right = this.expiries[rightIndex];
      if (!left) {
        break;
      }

      const childIndex = right && right.resetAt < left.resetAt ? rightIndex : leftIndex;
      const child = this.expiries[childIndex];
      if (!child || child.resetAt >= last.resetAt) {
        break;
      }
      this.expiries[index] = child;
      index = childIndex;
    }
    this.expiries[index] = last;
    return first;
  }
}

/**
 * Fixed-memory limiter for untrusted, high-cardinality keys.
 *
 * A count-min sketch avoids admission-slot exhaustion: distinct attacker keys
 * may add small collision noise, but they cannot fill a Map and force every
 * previously unseen legitimate key to fail closed.
 */
export class FixedWindowSketchRateLimiter implements RequestRateLimiter {
  private readonly rows: Uint32Array[];
  private readonly salt: number;
  private resetAt = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly width = 10_000,
    depth = 4,
    salt = Math.floor(Math.random() * 0x1_0000_0000),
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("rate-limit limit must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs < 1) {
      throw new Error("rate-limit windowMs must be positive");
    }
    if (!Number.isInteger(width) || width < 1) {
      throw new Error("rate-limit sketch width must be a positive integer");
    }
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error("rate-limit sketch depth must be a positive integer");
    }

    this.rows = Array.from({ length: depth }, () => new Uint32Array(width));
    this.salt = salt >>> 0;
  }

  consume(keys: string[], now = Date.now()): RateLimitDecision {
    this.rollWindow(now);
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    const estimates = uniqueKeys.map((key) => this.estimate(key));
    const blockedCount = estimates.find((count) => count >= this.limit);
    if (blockedCount !== undefined) {
      return this.decision(false, blockedCount, now);
    }

    let mostConsumed = 1;
    for (const key of uniqueKeys) {
      for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex += 1) {
        const row = this.rows[rowIndex];
        if (!row) {
          continue;
        }
        const index = this.hashIndex(key, rowIndex);
        if (row[index] !== 0xffff_ffff) {
          row[index] += 1;
        }
      }
      mostConsumed = Math.max(mostConsumed, this.estimate(key));
    }

    return this.decision(true, mostConsumed, now);
  }

  private rollWindow(now: number): void {
    if (this.resetAt !== 0 && now < this.resetAt) {
      return;
    }

    for (const row of this.rows) {
      row.fill(0);
    }
    this.resetAt = now + this.windowMs;
  }

  private estimate(key: string): number {
    let estimate = Number.POSITIVE_INFINITY;
    for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex += 1) {
      const row = this.rows[rowIndex];
      if (!row) {
        continue;
      }
      estimate = Math.min(estimate, row[this.hashIndex(key, rowIndex)]);
    }
    return estimate;
  }

  private hashIndex(key: string, rowIndex: number): number {
    let hash = (0x811c9dc5 ^ this.salt ^ Math.imul(rowIndex + 1, 0x9e3779b1)) >>> 0;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    return (hash >>> 0) % this.width;
  }

  private decision(allowed: boolean, count: number, now: number): RateLimitDecision {
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt: this.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((this.resetAt - now) / 1000)),
    };
  }
}
