import test from "node:test";
import assert from "node:assert/strict";
import { SCOPE_TEMPLATES } from "../index.js";

test("scope types are exported correctly", () => {
  assert.ok(SCOPE_TEMPLATES);
  assert.equal(typeof SCOPE_TEMPLATES["relaycast:full"], "object");
  assert.deepEqual(SCOPE_TEMPLATES["relayfile:read-only"].scopes, ["relayfile:fs:read:*"]);
});
