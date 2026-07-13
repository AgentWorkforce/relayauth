import assert from "node:assert/strict";
import test from "node:test";

import {
  FixedWindowRateLimiter,
  FixedWindowSketchRateLimiter,
} from "../lib/rate-limit.js";

test("FixedWindowRateLimiter fails closed instead of evicting active buckets", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000, 2);

  assert.equal(limiter.consume(["hot"], 0).allowed, true);
  assert.equal(limiter.consume(["other"], 1).allowed, true);

  const admission = limiter.consume(["attacker-controlled-new-key"], 2);
  assert.equal(admission.allowed, false);
  assert.equal(admission.remaining, 0);

  assert.equal(limiter.consume(["hot"], 3).allowed, true);
  assert.equal(
    limiter.consume(["hot"], 4).allowed,
    false,
    "capacity pressure must not reset an existing key's counter",
  );
});

test("FixedWindowRateLimiter admits a new key after the earliest bucket expires", () => {
  const limiter = new FixedWindowRateLimiter(1, 100, 2);

  assert.equal(limiter.consume(["first"], 0).allowed, true);
  assert.equal(limiter.consume(["second"], 10).allowed, true);
  assert.equal(limiter.consume(["third"], 50).allowed, false);
  assert.equal(limiter.consume(["third"], 100).allowed, true);
  assert.equal(limiter.consume(["second"], 100).allowed, false);
});

test("FixedWindowRateLimiter validates its capacity", () => {
  assert.throws(
    () => new FixedWindowRateLimiter(1, 1_000, 0),
    /maxEntries must be a positive integer/,
  );
});

test("FixedWindowSketchRateLimiter throttles repeated untrusted keys", () => {
  const limiter = new FixedWindowSketchRateLimiter(2, 1_000, 128, 4, 1);

  assert.equal(limiter.consume(["api-key-hash:repeated"], 0).allowed, true);
  assert.equal(limiter.consume(["api-key-hash:repeated"], 1).allowed, true);
  assert.equal(limiter.consume(["api-key-hash:repeated"], 2).allowed, false);
  assert.equal(limiter.consume(["api-key-hash:repeated"], 1_000).allowed, true);
});

test("FixedWindowSketchRateLimiter cannot exhaust admission slots with distinct keys", () => {
  const limiter = new FixedWindowSketchRateLimiter(60, 60_000, 10_000, 4, 1);

  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(limiter.consume([`api-key-hash:spray-${index}`], index).allowed, true);
  }

  assert.equal(
    limiter.consume(["api-key-hash:legitimate"], 10_001).allowed,
    true,
    "high-cardinality spray must not consume a finite admission map",
  );
});
