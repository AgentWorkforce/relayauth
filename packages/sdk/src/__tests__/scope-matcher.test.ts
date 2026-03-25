import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../index.js";

type ScopeMatcherApi = {
  matchScope?: (requested: string, granted: string[]) => unknown;
  matchesAny?: (requested: string[], granted: string[]) => unknown;
  validateSubset?: (parentScopes: string[], requestedScopes: string[]) => unknown;
};

function getMatcherApi(): Required<ScopeMatcherApi> {
  const api = sdk as ScopeMatcherApi;

  assert.equal(typeof api.matchScope, "function", "sdk should export matchScope");
  assert.equal(typeof api.matchesAny, "function", "sdk should export matchesAny");
  assert.equal(typeof api.validateSubset, "function", "sdk should export validateSubset");

  return api as Required<ScopeMatcherApi>;
}

test('matchScope returns true for an exact scope match', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relaycast:channel:read:*", ["relaycast:channel:read:*"]),
    true,
  );
});

test('matchScope returns true when a wildcard grant covers the request', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relaycast:channel:read:general", ["relaycast:*:*:*"]),
    true,
  );
});

test('matchScope returns false when the action does not match the grant', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relaycast:channel:write:*", ["relaycast:channel:read:*"]),
    false,
  );
});

test('matchScope returns true for relayfile path prefix grants', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relayfile:fs:write:/src/api/foo.ts", ["relayfile:fs:write:/src/*"]),
    true,
  );
});

test('matchScope returns false when a relayfile path falls outside the granted prefix', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relayfile:fs:write:/etc/passwd", ["relayfile:fs:write:/src/*"]),
    false,
  );
});

test('matchScope returns true for the superuser wildcard scope', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(matchScope("cloud:workflow:run", ["*:*:*:*"]), true);
});

test('matchScope returns false when no granted scopes are available', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(matchScope("relaycast:channel:read:*", []), false);
});

test('matchesAny returns matched and denied scopes for a partially granted request set', () => {
  const { matchesAny } = getMatcherApi();

  assert.deepEqual(
    matchesAny(
      ["relaycast:channel:read:*", "relayfile:fs:write:*"],
      ["relaycast:*:*:*"],
    ),
    {
      matched: ["relaycast:channel:read:*"],
      denied: ["relayfile:fs:write:*"],
    },
  );
});

test('matchScope treats manage as granting read, write, create, and delete but not unrelated actions', () => {
  const { matchScope } = getMatcherApi();
  const granted = ["relayauth:identity:manage:*"];

  assert.equal(matchScope("relayauth:identity:read:*", granted), true);
  assert.equal(matchScope("relayauth:identity:write:*", granted), true);
  assert.equal(matchScope("relayauth:identity:create:*", granted), true);
  assert.equal(matchScope("relayauth:identity:delete:*", granted), true);
  assert.equal(matchScope("relayauth:identity:run:*", granted), false);
});

test('matchScope applies relayfile path matching to sibling directories correctly', () => {
  const { matchScope } = getMatcherApi();
  const granted = ["relayfile:fs:write:/src/api/*"];

  assert.equal(matchScope("relayfile:fs:write:/src/api/foo", granted), true);
  assert.equal(matchScope("relayfile:fs:write:/src/lib/foo", granted), false);
});

test('validateSubset returns the requested scopes when they are already narrowed within the parent boundary', () => {
  const { validateSubset } = getMatcherApi();

  assert.deepEqual(
    validateSubset(
      ["relaycast:*:*:*", "relayfile:fs:write:/src/*"],
      ["relaycast:channel:read:*", "relayfile:fs:write:/src/api/*"],
    ),
    ["relaycast:channel:read:*", "relayfile:fs:write:/src/api/*"],
  );
});

test('validateSubset throws when the requested child scopes broaden the parent scope set', () => {
  const { validateSubset } = getMatcherApi();

  assert.throws(
    () => validateSubset(["relayfile:fs:write:/src/*"], ["relayfile:fs:write:*"]),
    /scope|subset|parent|broader|escalat/i,
  );
});

test('matchScope rejects path traversal attempts in relayfile scopes', () => {
  const { matchScope } = getMatcherApi();

  assert.throws(
    () => matchScope("relayfile:fs:write:/src/../etc/passwd", ["relayfile:fs:write:/src/*"]),
    /\.\./,
  );
});

test('matchScope handles 3-segment scopes with default wildcard path', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relaycast:channel:read", ["relaycast:channel:read:*"]),
    true,
  );
  assert.equal(
    matchScope("relaycast:channel:read", ["relaycast:channel:write:*"]),
    false,
  );
});

test('matchScope matches manage requested against manage granted', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relayauth:identity:manage:*", ["relayauth:identity:manage:*"]),
    true,
  );
});

test('matchScope matches root wildcard /* against any absolute path', () => {
  const { matchScope } = getMatcherApi();

  assert.equal(
    matchScope("relayfile:fs:read:/any/deep/path/file.ts", ["relayfile:fs:read:/*"]),
    true,
  );
  assert.equal(
    matchScope("relayfile:fs:read:/etc/passwd", ["relayfile:fs:read:/*"]),
    true,
  );
});
