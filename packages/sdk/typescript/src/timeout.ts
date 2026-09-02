// Shared timeout sanitizer for fetch aborts (JWKS + revocation lookups). Kept in
// ONE place so the SDK and core verifiers cannot drift on how they bound a
// caller-supplied timeout before handing it to AbortSignal.timeout.

/**
 * Upper bound for any fetch timeout override, well within Node's timer range so a
 * huge or overflowing value can never degrade to a 1ms (reject-everything) timer.
 */
export const MAX_TIMEOUT_MS = 60_000;

/**
 * Sanitize a caller-supplied timeout before it reaches `AbortSignal.timeout`.
 * A fractional value or one beyond Node's timer range would otherwise throw or
 * overflow to a 1ms timer, making the surrounding catch reject every request.
 * Floors to an integer and clamps to `[1ms, MAX_TIMEOUT_MS]`; falls back to
 * `fallback` when the value is NaN / non-finite / <= 0 / < 1ms after flooring.
 */
export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fallback;
  }

  const floored = Math.floor(timeoutMs);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, MAX_TIMEOUT_MS);
}
