/**
 * Deterministic JSON for signed ledger payloads. Objects are sorted
 * recursively; arrays retain their declared order because that order is part
 * of the payload. Unsupported JSON values are rejected rather than silently
 * changing the signed representation.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON does not support non-finite numbers");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON payload must use plain objects");
    }

    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const nested = object[key];
      if (nested === undefined) {
        throw new Error("canonical JSON does not support undefined values");
      }
      normalized[key] = canonicalizeValue(nested);
    }
    return normalized;
  }

  throw new Error("canonical JSON payload contains an unsupported value");
}
