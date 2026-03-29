import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedScope, RelayAuthTokenClaims } from "@relayauth/types";

import * as errors from "../errors.js";
import * as sdk from "../index.js";

type ScopeCheckerInstance = {
  check?: (scope: string) => unknown;
  require?: (scope: string) => unknown;
  checkAll?: (scopes: string[]) => unknown;
  checkAny?: (scopes: string[]) => unknown;
  effectiveScopes?: () => unknown;
};

type ScopeCheckerClass = {
  new (grantedScopes: string[]): ScopeCheckerInstance;
  fromToken?: (claims: RelayAuthTokenClaims) => ScopeCheckerInstance;
};

function getScopeChecker(): ScopeCheckerClass {
  const api = sdk as Record<string, unknown>;
  const ScopeChecker = api.ScopeChecker;

  assert.equal(typeof ScopeChecker, "function", "sdk should export ScopeChecker");

  return ScopeChecker as unknown as ScopeCheckerClass;
}

function getInsufficientScopeError(): new (...args: unknown[]) => Error {
  const api = errors as Record<string, unknown>;
  const InsufficientScopeError = api.InsufficientScopeError;

  assert.equal(
    typeof InsufficientScopeError,
    "function",
    "sdk errors should export InsufficientScopeError",
  );

  return InsufficientScopeError as new (...args: unknown[]) => Error;
}

function createChecker(grantedScopes: string[]): ScopeCheckerInstance {
  const ScopeChecker = getScopeChecker();
  return new ScopeChecker(grantedScopes);
}

function getCheckerApi(grantedScopes: string[]): Required<ScopeCheckerInstance> {
  const checker = createChecker(grantedScopes);

  assert.equal(typeof checker.check, "function", "ScopeChecker should implement check()");
  assert.equal(typeof checker.require, "function", "ScopeChecker should implement require()");
  assert.equal(typeof checker.checkAll, "function", "ScopeChecker should implement checkAll()");
  assert.equal(typeof checker.checkAny, "function", "ScopeChecker should implement checkAny()");
  assert.equal(
    typeof checker.effectiveScopes,
    "function",
    "ScopeChecker should implement effectiveScopes()",
  );

  return checker as Required<ScopeCheckerInstance>;
}

function buildClaims(scopes: string[]): RelayAuthTokenClaims {
  return {
    sub: "agent_scope_checker",
    org: "org_test",
    wks: "ws_test",
    scopes,
    sponsorId: "user_test",
    sponsorChain: ["user_test", "agent_scope_checker"],
    token_type: "access",
    iss: "relayauth:test",
    aud: ["relayauth"],
    exp: 1_900_000_000,
    iat: 1_899_999_000,
    jti: "jti_scope_checker",
  };
}

test("new ScopeChecker(grantedScopes) accepts granted scopes", () => {
  const ScopeChecker = getScopeChecker();
  const checker = new ScopeChecker(["relaycast:*:*:*"]);

  assert.ok(checker instanceof ScopeChecker);
});

test("checker.check returns true when a requested scope is granted", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);

  assert.equal(checker.check("relaycast:channel:read:general"), true);
});

test("checker.check returns false when a requested scope is not granted", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);

  assert.equal(checker.check("relayfile:fs:write:/src"), false);
});

test("checker.require does not throw when the scope is granted", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);

  assert.doesNotThrow(() => checker.require("relaycast:channel:read:*"));
});

test("checker.require throws InsufficientScopeError when the scope is not granted", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);
  const InsufficientScopeError = getInsufficientScopeError();

  assert.throws(() => checker.require("relayfile:fs:write:*"), InsufficientScopeError);
});

test("checker.checkAll returns true when every requested scope is granted", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);

  assert.equal(
    checker.checkAll([
      "relaycast:channel:read:*",
      "relaycast:channel:write:*",
    ]),
    true,
  );
});

test("checker.checkAll returns false when any requested scope is denied", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);

  assert.equal(
    checker.checkAll([
      "relaycast:channel:read:*",
      "relayfile:fs:write:*",
    ]),
    false,
  );
});

test("checker.checkAny returns true when at least one requested scope is granted", () => {
  const checker = getCheckerApi(["relaycast:*:*:*"]);

  assert.equal(
    checker.checkAny([
      "relayfile:fs:write:*",
      "relaycast:channel:read:*",
    ]),
    true,
  );
});

test("checker.effectiveScopes returns the parsed granted scopes", () => {
  const grantedScopes = ["relaycast:*:*:*", "relayfile:fs:read:/docs/*"];
  const checker = getCheckerApi(grantedScopes);

  assert.deepEqual(
    checker.effectiveScopes(),
    sdk.parseScopes(grantedScopes) as ParsedScope[],
  );
});

test("ScopeChecker.fromToken builds a checker from token claims", () => {
  const ScopeChecker = getScopeChecker();
  assert.equal(
    typeof ScopeChecker.fromToken,
    "function",
    "ScopeChecker should implement fromToken()",
  );
  const checker = ScopeChecker.fromToken!(buildClaims(["relaycast:*:*:*"]));
  const api = checker as Required<ScopeCheckerInstance>;

  assert.equal(typeof api.check, "function", "ScopeChecker.fromToken() should return a checker");
  assert.equal(api.check("relaycast:channel:read:general"), true);
});
