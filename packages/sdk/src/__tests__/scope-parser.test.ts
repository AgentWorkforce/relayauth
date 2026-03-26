import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../index.js";
import * as errors from "../errors.js";

type ScopeParserApi = {
  parseScope?: (raw: string) => unknown;
  parseScopes?: (raws: string[], opts?: { strict?: boolean }) => unknown;
  validateScope?: (raw: string) => unknown;
};

type ScopeSubsetApi = {
  isSubsetOf?: (scopes: string[], parents: string[]) => unknown;
};

function getParserApi(): Required<ScopeParserApi> {
  const api = sdk as ScopeParserApi;

  assert.equal(typeof api.parseScope, "function", "sdk should export parseScope");
  assert.equal(typeof api.parseScopes, "function", "sdk should export parseScopes");
  assert.equal(typeof api.validateScope, "function", "sdk should export validateScope");

  return api as Required<ScopeParserApi>;
}

function getSubsetApi(): Required<ScopeSubsetApi> {
  const api = sdk as ScopeSubsetApi;

  assert.equal(typeof api.isSubsetOf, "function", "sdk should export isSubsetOf");

  return api as Required<ScopeSubsetApi>;
}

function getInvalidScopeError(): new (...args: unknown[]) => Error {
  const api = errors as Record<string, unknown>;
  const InvalidScopeError = api.InvalidScopeError;

  assert.equal(
    typeof InvalidScopeError,
    "function",
    "sdk errors should export InvalidScopeError",
  );

  return InvalidScopeError as new (...args: unknown[]) => Error;
}

test('parseScope("relaycast:channel:read:*") returns the expected ParsedScope', () => {
  const { parseScope } = getParserApi();

  assert.deepEqual(parseScope("relaycast:channel:read:*"), {
    plane: "relaycast",
    resource: "channel",
    action: "read",
    path: "*",
    raw: "relaycast:channel:read:*",
  });
});

test('parseScope("relayfile:fs:write:/src/*") preserves the filesystem path constraint', () => {
  const { parseScope } = getParserApi();

  assert.deepEqual(parseScope("relayfile:fs:write:/src/*"), {
    plane: "relayfile",
    resource: "fs",
    action: "write",
    path: "/src/*",
    raw: "relayfile:fs:write:/src/*",
  });
});

test('parseScope("cloud:workflow:run") defaults the omitted path to "*"', () => {
  const { parseScope } = getParserApi();

  assert.deepEqual(parseScope("cloud:workflow:run"), {
    plane: "cloud",
    resource: "workflow",
    action: "run",
    path: "*",
    raw: "cloud:workflow:run",
  });
});

test('parseScope("*") expands the superuser wildcard alias', () => {
  const { parseScope } = getParserApi();

  assert.deepEqual(parseScope("*"), {
    plane: "*",
    resource: "*",
    action: "*",
    path: "*",
    raw: "*",
  });
});

test('parseScope("invalid") throws InvalidScopeError', () => {
  const { parseScope } = getParserApi();
  const InvalidScopeError = getInvalidScopeError();

  assert.throws(() => parseScope("invalid"), InvalidScopeError);
});

test('parseScope("") throws InvalidScopeError', () => {
  const { parseScope } = getParserApi();
  const InvalidScopeError = getInvalidScopeError();

  assert.throws(() => parseScope(""), InvalidScopeError);
});

test("parseScope rejects unknown planes", () => {
  const { parseScope } = getParserApi();
  const InvalidScopeError = getInvalidScopeError();

  assert.throws(() => parseScope("unknown:channel:read:*"), InvalidScopeError);
});

test("validateScope returns true for valid scope strings", () => {
  const { validateScope } = getParserApi();

  assert.equal(validateScope("relaycast:channel:read:*"), true);
  assert.equal(validateScope("relayfile:fs:read:/docs/*"), true);
  assert.equal(validateScope("relayauth:token:manage:*"), true);
});

test("validateScope returns false for malformed scope strings", () => {
  const { validateScope } = getParserApi();

  assert.equal(validateScope("invalid"), false);
  assert.equal(validateScope(""), false);
  assert.equal(validateScope("other:channel:read:*"), false);
  assert.equal(validateScope("relayfile:fs:read:docs/*"), false);
});

test("parseScopes parses an array of scope strings, including delegation-style scopes", () => {
  const { parseScopes } = getParserApi();

  assert.deepEqual(parseScopes([
    "relaycast:channel:read:*",
    "relayfile:fs:read:/docs/*",
    "relayauth:token:manage:*",
  ]), [
    {
      plane: "relaycast",
      resource: "channel",
      action: "read",
      path: "*",
      raw: "relaycast:channel:read:*",
    },
    {
      plane: "relayfile",
      resource: "fs",
      action: "read",
      path: "/docs/*",
      raw: "relayfile:fs:read:/docs/*",
    },
    {
      plane: "relayauth",
      resource: "token",
      action: "manage",
      path: "*",
      raw: "relayauth:token:manage:*",
    },
  ]);
});

test("parseScopes filters invalid scopes when called with strict: false", () => {
  const { parseScopes } = getParserApi();

  assert.deepEqual(
    parseScopes(
      [
        "relaycast:channel:read:*",
        "invalid",
        "relayfile:fs:read:/docs/*",
        "other:channel:read:*",
      ],
      { strict: false },
    ),
    [
      {
        plane: "relaycast",
        resource: "channel",
        action: "read",
        path: "*",
        raw: "relaycast:channel:read:*",
      },
      {
        plane: "relayfile",
        resource: "fs",
        action: "read",
        path: "/docs/*",
        raw: "relayfile:fs:read:/docs/*",
      },
    ],
  );
});

test("isSubsetOf returns true only when the child scope set is narrower than the parent scope set", () => {
  const { isSubsetOf } = getSubsetApi();

  const childScopes = [
    "relaycast:channel:read:#billing",
    "relayfile:fs:read:/docs/*",
  ];
  const parentScopes = [
    "relaycast:channel:read:*",
    "relayfile:fs:read:*",
  ];

  assert.equal(isSubsetOf(childScopes, parentScopes), true);
  assert.equal(isSubsetOf(parentScopes, childScopes), false);
});
