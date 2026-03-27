import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import * as server from "../index.js";
import { createApp } from "../worker.js";

function getRoutePaths(app: Hono): Set<string> {
  return new Set(app.routes.map((route) => route.path));
}

function assertRoutes(app: Hono, expectedPaths: string[]): void {
  const routePaths = getRoutePaths(app);

  for (const expectedPath of expectedPaths) {
    assert.ok(routePaths.has(expectedPath), `expected app.routes to include ${expectedPath}`);
  }
}

test("TestCreateAppReturnsHonoApp", () => {
  const app = createApp();

  assert.ok(app instanceof Hono, "createApp() should return a Hono instance");
  assertRoutes(app, ["/health"]);
});

test("TestCreateAppHasAllRoutes", () => {
  const app = createApp();

  assertRoutes(app, [
    "/health",
    "/v1/identities",
    "/v1/roles",
    "/v1/policies",
    "/.well-known/agent-configuration",
    "/.well-known/jwks.json",
  ]);
});

test("TestIndexExportsAll", () => {
  assert.equal(typeof server.createApp, "function", "index should export createApp()");
  assert.equal(typeof server.requireScope, "function", "index should export requireScope()");
  assert.equal(typeof server.IdentityDO, "function", "index should export IdentityDO");
  assert.match(
    Function.prototype.toString.call(server.IdentityDO),
    /^class\s+/,
    "IdentityDO should be exported as a class",
  );
});

test("TestAppFactoryIsIdempotent", () => {
  const app1 = createApp();
  const app2 = createApp();

  assert.notEqual(app1, app2, "createApp() should return a new app instance per call");
  assert.notEqual(app1.routes, app2.routes, "each app instance should keep its own route table");
  assert.deepEqual(
    [...getRoutePaths(app1)],
    [...getRoutePaths(app2)],
    "app instances should register the same routes",
  );
});
