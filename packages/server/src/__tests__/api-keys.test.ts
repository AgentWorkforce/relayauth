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
  orgId?: string;
  prefix: string;
  name: string;
  scopes: string[];
  createdAt?: string;
  revoked?: boolean;
  revokedAt?: string;
};

type ApiKeyCreateResponse = {
  apiKey: ApiKeyRecord;
  key: string;
};

type PaginatedApiKeyResponse = {
  data: ApiKeyRecord[];
  pagination?: {
    cursor?: string | null;
    hasMore: boolean;
    limit?: number;
  };
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
    orgId?: string;
  },
): Promise<ApiKeyCreateResponse> {
  const response = await app.request(
    createTestRequest("POST", "/v1/api-keys", body, createAdminAuthorizationHeader()),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 201, "POST /v1/api-keys should create an API key");
  return assertJsonResponse<ApiKeyCreateResponse>(response, 201);
}

async function createIdentityWithApiKey(
  app: ReturnType<typeof createTestApp>,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    createTestRequest("POST", "/v1/identities", body, {
      "x-api-key": apiKey,
    }),
    undefined,
    app.bindings,
  );
}

test("POST /v1/api-keys returns 201 with { apiKey, key } and a rak_ plaintext key", async () => {
  const app = createTestApp();

  const body = await createApiKey(app, {
    name: "sage-specialist-caller",
    scopes: ["relayauth:identity:manage:*", "relayauth:token:create:*"],
  });

  assert.equal(body.apiKey.name, "sage-specialist-caller");
  assert.deepEqual(body.apiKey.scopes, ["relayauth:identity:manage:*", "relayauth:token:create:*"]);
  assert.match(body.apiKey.id, /^ak_[A-Za-z0-9_-]+$/);
  assert.match(body.apiKey.prefix, /^rak_[A-Za-z0-9_-]{4,}/);
  assert.match(body.key, /^rak_[A-Za-z0-9_-]+$/);
  assert.ok(body.key.startsWith(body.apiKey.prefix), "returned plaintext should share the stored prefix");
});

test("POST /v1/api-keys rejects cross-org creation requests", async () => {
  const app = createTestApp();

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/api-keys",
      {
        name: "cross-org-should-fail",
        orgId: "org_other",
        scopes: ["relayauth:identity:manage:*"],
      },
      createAdminAuthorizationHeader(),
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ error: string; code?: string }>(response, 403);
  assert.equal(body.error, "org_mismatch");
  assert.equal(body.code, "org_mismatch");
});

test("an API key returned from POST /v1/api-keys authenticates POST /v1/identities via x-api-key", async () => {
  const app = createTestApp();
  const created = await createApiKey(app, {
    name: "identity-bootstrap",
    scopes: ["relayauth:identity:manage:*"],
  });

  const response = await createIdentityWithApiKey(app, created.key, {
    name: "service-created-via-api-key",
    sponsorId: "svc_sponsor_1",
    type: "service",
    metadata: {
      provisioner: "api-key-test",
    },
  });

  const body = await assertJsonResponse<AgentIdentity>(response, 201);

  assert.equal(body.name, "service-created-via-api-key");
  assert.equal(body.type, "service");
  assert.equal(body.orgId, "org_test");
});

test("a revoked API key returns 401 on subsequent POST /v1/identities requests", async () => {
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
  const revoked = await assertJsonResponse<ApiKeyRecord>(revokeResponse, 200);
  assert.equal(revoked.id, created.apiKey.id);

  const response = await createIdentityWithApiKey(app, created.key, {
    name: "should-not-create-after-revoke",
    sponsorId: "svc_sponsor_revoked",
  });

  const body = await assertJsonResponse<{ error: string; code?: string }>(response, 401);
  assert.match(body.error, /api key|revoked|invalid/i);
  assert.notEqual(body.code, "missing_authorization");
});

test("GET /v1/api-keys never returns the plaintext key and only exposes the prefix", async () => {
  const app = createTestApp();
  const created = await createApiKey(app, {
    name: "list-visible-prefix-only",
    scopes: ["relayauth:identity:manage:*"],
  });

  const response = await app.request(
    createTestRequest("GET", "/v1/api-keys", undefined, createAdminAuthorizationHeader()),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<PaginatedApiKeyResponse>(response, 200);

  assert.ok(Array.isArray(body.data));
  const listed = body.data.find((apiKey) => apiKey.id === created.apiKey.id);
  assert.ok(listed, "expected created API key to appear in the list response");
  assert.equal(listed?.prefix, created.apiKey.prefix);
  assert.equal("key" in (listed ?? {}), false, "list response must not expose plaintext keys");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(created.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
