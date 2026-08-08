/**
 * Produce a deterministic JSON representation for signed and hashed ledger
 * payloads. Object keys are sorted recursively; array order remains material.
 * Values JSON would silently discard are rejected instead.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
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

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested === undefined) {
        throw new Error("canonical JSON does not support undefined values");
      }
      normalized[key] = canonicalizeValue(nested);
    }
    return normalized;
  }

  throw new Error("canonical JSON payload contains an unsupported value");
}
