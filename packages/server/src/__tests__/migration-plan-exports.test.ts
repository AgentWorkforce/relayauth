import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalMigrationJson as canonicalFromRoot,
  normalizeMigrationGrantPairs as normalizeFromRoot,
  verifyStoredMigrationGrantPlan as verifyFromRoot,
} from "../index.js";
import {
  canonicalMigrationJson as canonicalFromStorage,
  normalizeMigrationGrantPairs as normalizeFromStorage,
  verifyStoredMigrationGrantPlan as verifyFromStorage,
  type MigrationGrantPlan,
} from "../storage/interface.js";

test("migration plan helpers are reachable from storage/interface and package root", () => {
  assert.equal(canonicalFromRoot, canonicalFromStorage);
  assert.equal(normalizeFromRoot, normalizeFromStorage);
  assert.equal(verifyFromRoot, verifyFromStorage);
  assert.equal(canonicalFromStorage({ z: 1, a: 2 }), '{"a":2,"z":1}');
  assert.deepEqual(
    normalizeFromStorage([
      { sourceUserId: "relay_user_b", workspaceId: "relay_ws_b" },
      { sourceUserId: "user_a", workspaceId: "ws_a" },
      { sourceUserId: "user_a", workspaceId: "ws_a" },
    ]),
    [
      { sourceUserId: "user_a", workspaceId: "ws_a" },
      { sourceUserId: "user_b", workspaceId: "ws_b" },
    ],
  );
});

test("the public persisted-plan verifier fails closed", () => {
  assert.throws(
    () =>
      verifyFromRoot({
        grantId: "mgr_00000000000000000000000000000000",
        orgId: "org_a",
        planDigest: "0".repeat(64),
        allowedPairs: [{ sourceUserId: "user_a", workspaceId: "ws_a" }],
        plan: {} as MigrationGrantPlan,
      }),
    /stored plan is malformed/u,
  );
});
