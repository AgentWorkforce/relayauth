import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIdentity } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type ApiKeyRecord = {
  id: string;
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

async function createApiKey(
  app: ReturnType<typeof createTestApp>,
  body: {
    name: string;
    scopes: string[];
  },
): Promise<ApiKeyCreateResponse> {
  const response = await app.request(
    createTestRequest("POST", "/v1/api-keys", body, createAdminAuthorizationHeader()),
    undefined,
    app.bindings,
  );

  return assertJsonResponse<ApiKeyCreateResponse>(response, 201);
}

async function postIdentityWithApiKey(
  app: ReturnType<typeof createTestApp>,
  apiKey: string,
  name: string,
): Promise<Response> {
  return app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name,
        sponsorId: "svc_identity_api_key",
        type: "service",
      },
      {
        "x-api-key": apiKey,
      },
    ),
    undefined,
    app.bindings,
  );
}

test("POST /v1/identities with valid x-api-key succeeds", async () => {
  const app = createTestApp();
  const created = await createApiKey(app, {
    name: "identity-bootstrap",
    scopes: ["relayauth:identity:manage:*"],
  });

  const response = await postIdentityWithApiKey(app, created.key, "service-created-via-api-key");
  const body = await assertJsonResponse<AgentIdentity>(response, 201);

  assert.equal(body.name, "service-created-via-api-key");
  assert.equal(body.type, "service");
  assert.equal(body.orgId, "org_test");
});

test("POST /v1/identities with x-api-key missing required scope returns 403", async () => {
  const app = createTestApp();
  const created = await createApiKey(app, {
    name: "identity-read-only",
    scopes: ["relayauth:identity:read:*"],
  });

  const response = await postIdentityWithApiKey(app, created.key, "service-insufficient-scope");
  const body = await assertJsonResponse<{ error: string }>(response, 403);

  assert.equal(body.error, "insufficient_scope");
});

test("POST /v1/identities with revoked x-api-key returns 401", async () => {
  const app = createTestApp();
  const created = await createApiKey(app, {
    name: "revoked-key",
    scopes: ["relayauth:identity:manage:*"],
  });

  const revokeResponse = await app.request(
    createTestRequest(
      "POST",
      `/v1/api-keys/${created.apiKey.id}/revoke`,
      {},
      createAdminAuthorizationHeader(),
    ),
    undefined,
    app.bindings,
  );
  await assertJsonResponse(revokeResponse, 200);

  const response = await postIdentityWithApiKey(app, created.key, "service-revoked-key");
  const body = await assertJsonResponse<{ error: string; code?: string }>(response, 401);

  assert.match(body.error, /api key|revoked|invalid/i);
  assert.notEqual(body.code, "missing_authorization");
});
