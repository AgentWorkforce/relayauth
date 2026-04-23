import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AgentIdentity } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

// Regression tests for the Cloudflare Workers immutable-headers bug. See
// packages/server/src/middleware/api-key-auth.ts for context. The previous
// implementation did `c.req.raw.headers.set("authorization", ...)` after
// authenticating an x-api-key, which throws
// `TypeError: Can't modify immutable headers` on Workers' locked Request
// headers. Every x-api-key request hit 500 in production. The tests in this
// file guard against reintroducing that behavior.

type ApiKeyRecord = { id: string };
type ApiKeyCreateResponse = { apiKey: ApiKeyRecord; key: string };

function createAdminAuthHeader(): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken({
      sub: "agent_admin_api_keys",
      org: "org_test",
      wks: "ws_admin",
      sponsorId: "user_admin_api_keys",
      sponsorChain: ["user_admin_api_keys", "agent_admin_api_keys"],
      scopes: ["*"],
    })}`,
  };
}

async function mintApiKey(
  app: ReturnType<typeof createTestApp>,
  scopes: string[],
): Promise<ApiKeyCreateResponse> {
  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/api-keys",
      { name: "middleware-test-key", scopes },
      createAdminAuthHeader(),
    ),
    undefined,
    app.bindings,
  );

  return assertJsonResponse<ApiKeyCreateResponse>(response, 201);
}

/**
 * Simulate the Cloudflare Workers guarantee that `Request.headers` is locked
 * after construction. We freeze the Headers instance so any `.set()` /
 * `.delete()` / `.append()` call throws, matching the Workers runtime
 * behavior and reproducing the original production bug.
 */
function createLockedHeadersRequest(
  method: string,
  path: string,
  body: unknown,
  headers: HeadersInit,
): Request {
  const req = createTestRequest(method, path, body, headers);
  const rawHeaders = req.headers;
  const throwImmutable = () => {
    throw new TypeError("Can't modify immutable headers.");
  };
  Object.defineProperty(rawHeaders, "set", { value: throwImmutable, configurable: true });
  Object.defineProperty(rawHeaders, "delete", { value: throwImmutable, configurable: true });
  Object.defineProperty(rawHeaders, "append", { value: throwImmutable, configurable: true });
  return req;
}

test("apiKeyAuth source no longer calls .headers.set(...) on the raw Request", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const middlewarePath = join(here, "..", "middleware", "api-key-auth.ts");
  const source = readFileSync(middlewarePath, "utf8");

  // Strip comments so this regression guard matches only executable code. The
  // failure mode in Workers was `c.req.raw.headers.set("authorization", ...)`.
  // Any of these patterns in real code is a regression.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .replace(/^\s*\/\/.*$/gm, ""); // line comments

  assert.doesNotMatch(
    code,
    /\.headers\.set\(/,
    "apiKeyAuth code must not mutate headers (Workers immutable-headers incompat)",
  );
  assert.doesNotMatch(
    code,
    /c\.req\.raw\.headers/,
    "apiKeyAuth code must not reach into c.req.raw.headers at all",
  );
  assert.doesNotMatch(
    code,
    /signHs256Token\s*\(/,
    "apiKeyAuth code must not synthesize HS256 bearers from api-key claims",
  );
});

test("POST /v1/identities with x-api-key succeeds against a Workers-style locked-headers Request", async () => {
  const app = createTestApp();
  const created = await mintApiKey(app, ["relayauth:identity:manage:*"]);

  const response = await app.request(
    createLockedHeadersRequest(
      "POST",
      "/v1/identities",
      {
        name: "svc-via-locked-headers-request",
        sponsorId: "svc_sponsor_locked",
        type: "service",
      },
      { "x-api-key": created.key },
    ),
    undefined,
    app.bindings,
  );

  // The ORIGINAL bug surfaced as a 500 from the TypeError. We assert the
  // status first so regressions produce a crisp failure message.
  assert.notEqual(
    response.status,
    500,
    "x-api-key auth must not 500 on a Workers-style Request with immutable headers",
  );

  const body = await assertJsonResponse<AgentIdentity>(response, 201);
  assert.equal(body.name, "svc-via-locked-headers-request");
});

test("POST /v1/tokens with x-api-key succeeds against a Workers-style locked-headers Request", async () => {
  const app = createTestApp();
  const created = await mintApiKey(app, [
    "relayauth:identity:manage:*",
    "relayauth:token:create:*",
  ]);

  // First create an identity we can mint tokens for, via a normal request.
  const identityResponse = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "svc-target-for-token-mint",
        sponsorId: "svc_sponsor_token",
        type: "service",
        scopes: ["relayauth:identity:read:*"],
      },
      { "x-api-key": created.key },
    ),
    undefined,
    app.bindings,
  );
  const identity = await assertJsonResponse<AgentIdentity>(identityResponse, 201);

  // Now exercise POST /v1/tokens with the locked-headers request. This is the
  // exact codepath that 500'd in production (sage worker minting a bearer).
  const tokenResponse = await app.request(
    createLockedHeadersRequest(
      "POST",
      "/v1/tokens",
      { identityId: identity.id },
      { "x-api-key": created.key },
    ),
    undefined,
    app.bindings,
  );

  assert.notEqual(
    tokenResponse.status,
    500,
    "POST /v1/tokens with x-api-key must not 500 on a Workers-style Request",
  );
  assert.equal(tokenResponse.status, 201);

  const tokens = await tokenResponse.json() as {
    accessToken?: string;
    refreshToken?: string;
  };
  assert.equal(typeof tokens.accessToken, "string");
  assert.equal(typeof tokens.refreshToken, "string");
});

test("bearer-wins precedence: a valid bearer takes over even when x-api-key is also present", async () => {
  const app = createTestApp();
  const created = await mintApiKey(app, ["relayauth:identity:read:*"]);

  // The api-key scope is read-only and would FAIL scope checks for POST. A
  // manage-scoped bearer alongside the api-key must win, letting the request
  // succeed. This is the precedence that was previously tested via the
  // synthesized-bearer header rewrite path.
  const bearerHeader = `Bearer ${generateTestToken({
    sub: "agent_precedence_bearer",
    org: "org_test",
    wks: "ws_precedence",
    sponsorId: "user_precedence",
    sponsorChain: ["user_precedence", "agent_precedence_bearer"],
    scopes: ["relayauth:identity:manage:*"],
  })}`;

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "svc-created-via-bearer-precedence",
        sponsorId: "svc_sponsor_precedence",
        type: "service",
      },
      {
        Authorization: bearerHeader,
        "x-api-key": created.key,
      },
    ),
    undefined,
    app.bindings,
  );

  // If the api-key won, the request would be 403 (insufficient_scope). Bearer
  // must win.
  const body = await assertJsonResponse<AgentIdentity>(response, 201);
  assert.equal(body.name, "svc-created-via-bearer-precedence");
});
