import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type ApiKeyRecord = {
  id: string;
  scopes: string[];
};

type ApiKeyCreateResponse = {
  apiKey: ApiKeyRecord;
  key: string;
};

function createAdminAuthorizationHeader(): HeadersInit {
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

async function mintApiKeyViaBearer(
  app: ReturnType<typeof createTestApp>,
  body: { name: string; scopes: string[] },
): Promise<ApiKeyCreateResponse> {
  const response = await app.request(
    createTestRequest("POST", "/v1/api-keys", body, createAdminAuthorizationHeader()),
    undefined,
    app.bindings,
  );

  return assertJsonResponse<ApiKeyCreateResponse>(response, 201);
}

test("POST /v1/api-keys with valid x-api-key mints a new key without a bearer token", async () => {
  const app = createTestApp();
  const operator = await mintApiKeyViaBearer(app, {
    name: "operator-key",
    scopes: ["*:*:*:*"],
  });

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/api-keys",
      { name: "minted-via-api-key", scopes: ["relayauth:identity:manage:*"] },
      { "x-api-key": operator.key },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<ApiKeyCreateResponse>(response, 201);
  assert.equal(body.apiKey.scopes[0], "relayauth:identity:manage:*");
  assert.ok(body.key.length > 0, "expected a minted api-key value");
});

test("POST /v1/api-keys with x-api-key missing required scope returns 403", async () => {
  const app = createTestApp();
  const readOnly = await mintApiKeyViaBearer(app, {
    name: "read-only-operator",
    scopes: ["relayauth:api-key:read:*"],
  });

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/api-keys",
      { name: "should-not-mint", scopes: ["relayauth:identity:manage:*"] },
      { "x-api-key": readOnly.key },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ error: string }>(response, 403);
  assert.equal(body.error, "insufficient_scope");
});

test("GET /v1/api-keys with valid x-api-key lists api-keys", async () => {
  const app = createTestApp();
  const reader = await mintApiKeyViaBearer(app, {
    name: "reader-key",
    scopes: ["relayauth:api-key:read:*"],
  });

  const response = await app.request(
    createTestRequest("GET", "/v1/api-keys", undefined, { "x-api-key": reader.key }),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ data: ApiKeyRecord[] }>(response, 200);
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((row) => row.id === reader.apiKey.id), "listing should include the caller's own api-key");
});

test("POST /v1/api-keys/:id/revoke with valid x-api-key revokes the target key", async () => {
  const app = createTestApp();
  const operator = await mintApiKeyViaBearer(app, {
    name: "revoker-key",
    scopes: ["*:*:*:*"],
  });
  const target = await mintApiKeyViaBearer(app, {
    name: "soon-to-be-revoked",
    scopes: ["relayauth:identity:read:*"],
  });

  const response = await app.request(
    createTestRequest(
      "POST",
      `/v1/api-keys/${target.apiKey.id}/revoke`,
      {},
      { "x-api-key": operator.key },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ id: string; revoked: boolean }>(response, 200);
  assert.equal(body.id, target.apiKey.id);
  assert.equal(body.revoked, true);
});

test("POST /v1/api-keys with revoked x-api-key returns 401", async () => {
  const app = createTestApp();
  const operator = await mintApiKeyViaBearer(app, {
    name: "to-be-revoked-operator",
    scopes: ["*:*:*:*"],
  });

  const revokeResponse = await app.request(
    createTestRequest(
      "POST",
      `/v1/api-keys/${operator.apiKey.id}/revoke`,
      {},
      createAdminAuthorizationHeader(),
    ),
    undefined,
    app.bindings,
  );
  await assertJsonResponse(revokeResponse, 200);

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/api-keys",
      { name: "should-fail", scopes: ["relayauth:identity:read:*"] },
      { "x-api-key": operator.key },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ error: string; code?: string }>(response, 401);
  assert.match(body.error, /api key|revoked|invalid/i);
  assert.notEqual(body.code, "missing_authorization");
});
