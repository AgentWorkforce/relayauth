/**
 * Snowflake id allocation, vendored from `@relaycast/engine`
 * (packages/engine/src/engine/snowflake.ts) so a workspace id RelayAuth
 * allocates is interchangeable with one relaycast's `generateId` would mint:
 * same epoch (2025-01-01), same layout — 41-bit ms timestamp, 10-bit worker,
 * 12-bit sequence. The worker id is an FNV-1a hash of a per-process UUID, so
 * two allocators could in principle draw the same worker id; the collision
 * space (worker × millisecond × sequence) is the same one relaycast accepts
 * between its own isolates.
 */

const EPOCH_MS = Date.UTC(2025, 0, 1); // 2025-01-01T00:00:00Z

const WORKER_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n; // 0..4095
const WORKER_ID_MASK = (1n << WORKER_ID_BITS) - 1n; // 0..1023
const WORKER_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS;

let _processId: string | undefined;
function getProcessId(): string {
  if (!_processId) _processId = crypto.randomUUID();
  return _processId;
}

function fnv1a10Bits(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x3ff;
}

export class SnowflakeGenerator {
  private workerId?: number;
  private lastTimestamp = -1;
  private sequence = 0;

  constructor(workerId?: number) {
    this.workerId = workerId;
  }

  private getWorkerId(): number {
    if (typeof this.workerId === "number") {
      return this.workerId & 0x3ff;
    }
    return fnv1a10Bits(getProcessId());
  }

  generate(): string {
    const wid = this.getWorkerId();
    let now = Date.now();
    if (now < this.lastTimestamp) {
      now = this.lastTimestamp;
    }

    if (now === this.lastTimestamp) {
      this.sequence = (this.sequence + 1) & Number(SEQUENCE_MASK);
      if (this.sequence === 0) {
        while (now <= this.lastTimestamp) now = Date.now();
      }
    } else {
      this.sequence = 0;
    }

    this.lastTimestamp = now;

    const ts = BigInt(now - EPOCH_MS);
    const id =
      (ts << TIMESTAMP_SHIFT)
      | ((BigInt(wid) & WORKER_ID_MASK) << WORKER_ID_SHIFT)
      | (BigInt(this.sequence) & SEQUENCE_MASK);

    return id.toString();
  }
}

let defaultGenerator: SnowflakeGenerator | null = null;

/** A fresh 64-bit snowflake as decimal text — a valid `ar_` workspace id. */
export function generateSnowflakeId(): string {
  if (!defaultGenerator) {
    defaultGenerator = new SnowflakeGenerator();
  }
  return defaultGenerator.generate();
}
