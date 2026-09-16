import assert from "node:assert/strict";
import test from "node:test";
import { createTestApp } from "./test-helpers.js";

/**
 * `/v1/tokens/revocation` is bucketed per client IP. Cloudflare Workers egress
 * from shared addresses, so unrelated service-to-service verifiers collapse
 * into a handful of buckets and exhaust one without any of them being abusive.
 * The endpoint fails closed — a 429 makes the SDK verifier reject an otherwise
 * valid token — so the ceiling needs to be tunable without a release.
 *
 * The limiters are memoized at module scope by (limit, windowMs) so that the
 * cloud entrypoint's per-request createApp() keeps one bucket per isolate.
 * That cache is process-wide, so each test below picks a DISTINCT window to get
 * its own bucket.
 */
const WINDOW_RAISED = "60011";
const WINDOW_ENFORCED = "60012";
const WINDOW_CLAMPED = "60013";
const WINDOW_MALFORMED = "60014";
const WINDOW_ISOLATION = "60015";

function checkRevocation(
  app: ReturnType<typeof createTestApp>,
  ip: string,
  jti = "jti_probe",
) {
  return app.request(
    `/v1/tokens/revocation?jti=${jti}`,
    { headers: { "x-forwarded-for": ip } },
    app.bindings,
  );
}

test("an operator binding raises the revocation-check ceiling above the built-in default", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_REVOCATION_CHECK_RATE_LIMIT: "5000",
      RELAYAUTH_REVOCATION_CHECK_RATE_WINDOW_MS: WINDOW_RAISED,
    },
    { useBindingRevocationCheckRateLimiter: true },
  );

  const response = await checkRevocation(app, "198.51.100.10");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("RateLimit-Limit"),
    "5000",
    "the configured ceiling must replace the built-in default of 600",
  );
});

test("the configured revocation-check ceiling is the value actually enforced", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_REVOCATION_CHECK_RATE_LIMIT: "3",
      RELAYAUTH_REVOCATION_CHECK_RATE_WINDOW_MS: WINDOW_ENFORCED,
    },
    { useBindingRevocationCheckRateLimiter: true },
  );
  const ip = "198.51.100.11";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const allowed = await checkRevocation(app, ip);
    assert.equal(allowed.status, 200, `check ${attempt + 1} should be admitted under a ceiling of 3`);
  }

  const rejected = await checkRevocation(app, ip);
  assert.equal(rejected.status, 429);
  const body = (await rejected.json()) as { code?: string };
  assert.equal(body.code, "rate_limited");
  assert.ok(rejected.headers.get("Retry-After"), "a throttled caller needs Retry-After");
});

// NEGATIVE: the binding is a tuning dial, not an off switch.
test("an oversized revocation-check binding is clamped instead of disabling protection", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_REVOCATION_CHECK_RATE_LIMIT: "999999999",
      RELAYAUTH_REVOCATION_CHECK_RATE_WINDOW_MS: WINDOW_CLAMPED,
    },
    { useBindingRevocationCheckRateLimiter: true },
  );

  const response = await checkRevocation(app, "198.51.100.12");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("RateLimit-Limit"),
    "120000",
    "an oversized ceiling must clamp to the supported maximum, not apply verbatim",
  );
});

// NEGATIVE: malformed config must fail safe — keep the protective default —
// rather than fail open (unlimited) or fail closed (endpoint offline). This
// endpoint rejecting tokens is a live security-visible outage, so "offline" is
// not an acceptable response to a typo.
test("a malformed revocation-check binding falls back to the protective default", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_REVOCATION_CHECK_RATE_LIMIT: "six hundred",
      RELAYAUTH_REVOCATION_CHECK_RATE_WINDOW_MS: WINDOW_MALFORMED,
    },
    { useBindingRevocationCheckRateLimiter: true },
  );

  const response = await checkRevocation(app, "198.51.100.13");

  assert.equal(response.status, 200, "a malformed binding must not take the endpoint offline");
  assert.equal(
    response.headers.get("RateLimit-Limit"),
    "600",
    "a malformed binding must fall back to the default ceiling, not become unlimited",
  );
});

// NEGATIVE: raising the ceiling must not turn the limiter into a no-op, and must
// not let one exhausted client starve an unrelated one. An abusive caller is
// still cut off at its configured ceiling while a different IP is still served.
test("a raised ceiling still throttles an abusive client without starving others", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_REVOCATION_CHECK_RATE_LIMIT: "3",
      RELAYAUTH_REVOCATION_CHECK_RATE_WINDOW_MS: WINDOW_ISOLATION,
    },
    { useBindingRevocationCheckRateLimiter: true },
  );
  const abusive = "203.0.113.50";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await checkRevocation(app, abusive)).status, 200);
  }

  assert.equal(
    (await checkRevocation(app, abusive)).status,
    429,
    "a configurable ceiling must still throttle the client that exhausts it",
  );

  assert.equal(
    (await checkRevocation(app, "203.0.113.51")).status,
    200,
    "one exhausted bucket must not reject an unrelated verifier",
  );
});
