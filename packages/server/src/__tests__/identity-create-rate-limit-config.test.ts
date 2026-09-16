import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  createTestStorage,
  generateTestToken,
} from "./test-helpers.js";

/**
 * The identity-create limiters are memoized at module scope, keyed by
 * (limit, windowMs), so that the cloud entrypoint's per-request createApp()
 * keeps one bucket per isolate. That makes the cache shared process-wide, so
 * every test below picks a DISTINCT window value to get its own bucket and
 * avoid bleeding counts into its neighbours.
 */
const WINDOW_RAISED = "60001";
const WINDOW_ENFORCED = "60002";
const WINDOW_CLAMPED = "60003";
const WINDOW_MALFORMED = "60004";
const WINDOW_SHARED_BUCKET = "60005";

function createAuthToken(overrides: Partial<RelayAuthTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const sponsorId = overrides.sponsorId ?? "user_sponsor_1";
  const sub = overrides.sub ?? "agent_parent_1";

  return generateTestToken({
    sub,
    org: overrides.org ?? "org_auth_ctx",
    wks: overrides.wks ?? "ws_auth_ctx",
    scopes: overrides.scopes ?? ["relayauth:identity:create", "relayauth:identity:manage"],
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, sub],
    token_type: "access",
    iss: "relayauth:test",
    aud: ["relayauth"],
    exp: now + 3600,
    iat: now,
    jti: crypto.randomUUID(),
  });
}

function createIdentityRequest(name: string, token: string) {
  return createTestRequest(
    "POST",
    "/v1/identities",
    { name, sponsorId: "user_sponsor_1" },
    { Authorization: `Bearer ${token}` },
  );
}

test("an operator binding raises the identity-create ceiling above the built-in default", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_IDENTITY_CREATE_RATE_LIMIT: "500",
      RELAYAUTH_IDENTITY_CREATE_RATE_WINDOW_MS: WINDOW_RAISED,
    },
    { useBindingIdentityCreateRateLimiters: true },
  );
  const token = createAuthToken();

  const response = await app.request(
    createIdentityRequest("raised-ceiling", token),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 201);
  assert.equal(
    response.headers.get("RateLimit-Limit"),
    "500",
    "the configured ceiling must replace the built-in default of 60",
  );
});

test("the configured ceiling is the value actually enforced", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_IDENTITY_CREATE_RATE_LIMIT: "2",
      RELAYAUTH_IDENTITY_CREATE_RATE_WINDOW_MS: WINDOW_ENFORCED,
    },
    { useBindingIdentityCreateRateLimiters: true },
  );
  const token = createAuthToken();

  for (const name of ["enforced-first", "enforced-second"]) {
    const allowed = await app.request(createIdentityRequest(name, token), undefined, app.bindings);
    assert.equal(allowed.status, 201, `${name} should be admitted under a ceiling of 2`);
  }

  const rejected = await app.request(
    createIdentityRequest("enforced-third", token),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code?: string; retryable?: boolean }>(rejected, 429);
  assert.equal(body.code, "rate_limited");
  assert.equal(body.retryable, true);
  assert.equal(rejected.headers.get("RateLimit-Remaining"), "0");
});

// NEGATIVE: the binding is a tuning dial, not an off switch. An operator who
// fat-fingers a huge value must still get a bounded limiter.
test("an oversized binding is clamped instead of disabling abuse protection", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_IDENTITY_CREATE_RATE_LIMIT: "999999999",
      RELAYAUTH_IDENTITY_CREATE_RATE_WINDOW_MS: WINDOW_CLAMPED,
    },
    { useBindingIdentityCreateRateLimiters: true },
  );
  const token = createAuthToken();

  const response = await app.request(
    createIdentityRequest("clamped-ceiling", token),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 201);
  assert.equal(
    response.headers.get("RateLimit-Limit"),
    "6000",
    "an oversized ceiling must clamp to the supported maximum, not apply verbatim",
  );
});

// NEGATIVE: malformed config must fail safe — keep the protective default —
// rather than fail open (no limit) or fail closed (route offline).
test("a malformed binding falls back to the protective default", async () => {
  const app = createTestApp(
    {
      RELAYAUTH_IDENTITY_CREATE_RATE_LIMIT: "sixty-please",
      RELAYAUTH_IDENTITY_CREATE_RATE_WINDOW_MS: WINDOW_MALFORMED,
    },
    { useBindingIdentityCreateRateLimiters: true },
  );
  const token = createAuthToken();

  const response = await app.request(
    createIdentityRequest("malformed-binding", token),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 201, "a malformed binding must not take the route offline");
  assert.equal(
    response.headers.get("RateLimit-Limit"),
    "60",
    "a malformed binding must fall back to the default ceiling, not become unlimited",
  );
});

// NEGATIVE / REGRESSION GUARD: the cloud entrypoint builds an app per request.
// If the binding-sized limiter were constructed inside createApp(), every
// request would receive a freshly zeroed bucket and the limiter would silently
// stop limiting while still reporting a ceiling. Two apps sharing one config
// must share one bucket.
test("apps rebuilt per request share one bucket instead of resetting the count", async () => {
  const storage = createTestStorage();
  const bindings = {
    RELAYAUTH_IDENTITY_CREATE_RATE_LIMIT: "2",
    RELAYAUTH_IDENTITY_CREATE_RATE_WINDOW_MS: WINDOW_SHARED_BUCKET,
  } as const;
  const options = { storage, useBindingIdentityCreateRateLimiters: true };

  const firstApp = createTestApp({ ...bindings }, options);
  const secondApp = createTestApp({ ...bindings }, options);
  const token = createAuthToken();

  const first = await firstApp.request(
    createIdentityRequest("shared-bucket-first", token),
    undefined,
    firstApp.bindings,
  );
  assert.equal(first.status, 201);

  const second = await secondApp.request(
    createIdentityRequest("shared-bucket-second", token),
    undefined,
    secondApp.bindings,
  );
  assert.equal(second.status, 201);

  // A third create against a ceiling of 2 must be refused even though it
  // arrives at a different app instance than the first two.
  const third = await secondApp.request(
    createIdentityRequest("shared-bucket-third", token),
    undefined,
    secondApp.bindings,
  );
  const body = await assertJsonResponse<{ code?: string }>(third, 429);
  assert.equal(
    body.code,
    "rate_limited",
    "rebuilding the app per request must not hand out a fresh, unlimited bucket",
  );
});
