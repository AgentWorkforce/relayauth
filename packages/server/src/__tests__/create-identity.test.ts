import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { AgentIdentity, CreateIdentityInput, RelayAuthTokenClaims } from "@relayauth/types";
import { FixedWindowRateLimiter, RateLimitExceededError } from "../lib/rate-limit.js";
import { StorageCapacityExhaustedError } from "../lib/storage-retry.js";
import type { IdentityBudget, StoredIdentity } from "../storage/identity-types.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  createTestStorage,
  generateTestIdentity,
  generateTestToken,
  seedOrgBudget,
  seedStoredIdentity,
} from "./test-helpers.js";

type CreateIdentityRequest = CreateIdentityInput & {
  sponsorId?: string;
  budget?: IdentityBudget;
  orgId?: string;
};

type CreatedIdentity = AgentIdentity & {
  sponsorId?: string;
  sponsorChain?: string[];
  workspaceId?: string;
  budget?: IdentityBudget;
};

function createAuthToken(overrides: Partial<RelayAuthTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const sponsorId = overrides.sponsorId ?? "user_sponsor_1";
  const sub = overrides.sub ?? "agent_parent_1";

  const payload: RelayAuthTokenClaims = {
    sub,
    org: overrides.org ?? "org_auth_ctx",
    wks: overrides.wks ?? "ws_auth_ctx",
    scopes: overrides.scopes ?? ["relayauth:identity:create", "relayauth:identity:manage"],
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, sub],
    token_type: overrides.token_type ?? "access",
    iss: overrides.iss ?? "relayauth:test",
    aud: overrides.aud ?? ["relayauth"],
    exp: overrides.exp ?? now + 3600,
    iat: overrides.iat ?? now,
    jti: overrides.jti ?? crypto.randomUUID(),
    nbf: overrides.nbf,
    sid: overrides.sid,
    meta: overrides.meta,
    parentTokenId: overrides.parentTokenId,
    budget: overrides.budget,
  };

  return generateTestToken(payload);
}


function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_sponsor_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, "agent_parent_1", base.id],
    workspaceId: overrides.workspaceId ?? "ws_auth_ctx",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function assertIsoTimestamp(value: string, fieldName: string): void {
  assert.equal(typeof value, "string", `${fieldName} should be a string`);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${fieldName} should be an ISO timestamp`);
}

async function postCreateIdentity(
  body: CreateIdentityRequest,
  {
    claims,
    duplicateIdentity,
    orgBudget,
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    duplicateIdentity?: StoredIdentity;
    orgBudget?: IdentityBudget;
  } = {},
): Promise<Response> {
  const app = createTestApp();
  if (duplicateIdentity) {
    await seedStoredIdentity(app, duplicateIdentity);
  }
  if (orgBudget) {
    await seedOrgBudget(app, claims?.org ?? "org_auth_ctx", orgBudget);
  }
  const request = createTestRequest(
    "POST",
    "/v1/identities",
    body,
    {
      Authorization: `Bearer ${createAuthToken(claims)}`,
    },
  );

  return app.request(request, undefined, app.bindings);
}

test("POST /v1/identities returns 201 with a created identity and preserves optional fields", async () => {
  const response = await postCreateIdentity({
    name: "builder-bot",
    sponsorId: "user_sponsor_1",
    scopes: ["relayauth:identity:read", "relayauth:identity:update"],
    roles: ["builder", "deployer"],
    metadata: {
      environment: "test",
      owner: "qa",
    },
    workspaceId: "ws_edge",
    orgId: "org_untrusted_payload",
  });

  const body = await assertJsonResponse<CreatedIdentity>(response, 201);

  assert.match(body.id, /^agent_[A-Za-z0-9_-]+$/);
  assert.equal(body.name, "builder-bot");
  assert.equal(body.type, "agent");
  assert.equal(body.status, "active");
  assert.equal(body.orgId, "org_auth_ctx");
  assert.equal(body.sponsorId, "user_sponsor_1");
  assert.deepEqual(body.scopes, ["relayauth:identity:read", "relayauth:identity:update"]);
  assert.deepEqual(body.roles, ["builder", "deployer"]);
  assert.deepEqual(body.metadata, { environment: "test", owner: "qa" });
  assert.equal(body.workspaceId, "ws_edge");
  assertIsoTimestamp(body.createdAt, "createdAt");
  assertIsoTimestamp(body.updatedAt, "updatedAt");
});

test("POST /v1/identities returns 400 when name is missing", async () => {
  const response = await postCreateIdentity({
    sponsorId: "user_sponsor_1",
  } as CreateIdentityRequest);

  const body = await assertJsonResponse<Record<string, unknown>>(response, 400);

  assert.match(JSON.stringify(body), /name/i);
});

test("POST /v1/identities returns 400 when sponsorId is missing", async () => {
  const response = await postCreateIdentity({
    name: "missing-sponsor",
  });

  const body = await assertJsonResponse<Record<string, unknown>>(response, 400);

  assert.match(JSON.stringify(body), /sponsor/i);
});

test("POST /v1/identities auto-populates sponsorChain from the authenticated parent agent", async () => {
  const response = await postCreateIdentity(
    {
      name: "child-agent",
      sponsorId: "user_jane",
    },
    {
      claims: {
        sub: "agent_parent_9",
        org: "org_delegated",
        wks: "ws_delegate",
        sponsorId: "user_jane",
        sponsorChain: ["user_jane", "agent_root_1", "agent_parent_9"],
      },
    },
  );

  const body = await assertJsonResponse<CreatedIdentity>(response, 201);

  // sponsorChain should be parent's chain + the NEW identity's ID (not parent's sub)
  assert.equal(body.sponsorChain.length, 4);
  assert.deepEqual(body.sponsorChain.slice(0, 3), ["user_jane", "agent_root_1", "agent_parent_9"]);
  assert.equal(body.sponsorChain[3], body.id);
});

test("POST /v1/identities defaults budget from the org when the request omits budget", async () => {
  const orgBudget: IdentityBudget = {
    maxActionsPerHour: 120,
    maxCostPerDay: 35,
    alertThreshold: 0.85,
    autoSuspend: true,
  };
  const response = await postCreateIdentity(
    {
      name: "budgeted-agent",
      sponsorId: "user_budget_owner",
    },
    {
      orgBudget,
    },
  );

  const body = await assertJsonResponse<CreatedIdentity>(response, 201);

  assert.deepEqual(body.budget, orgBudget);
});

test("POST /v1/identities returns 409 when an identity with the same name already exists in the org", async () => {
  const response = await postCreateIdentity(
    {
      name: "existing-agent",
      sponsorId: "user_sponsor_1",
    },
    {
      duplicateIdentity: createStoredIdentity({
          id: "agent_existing_1",
          name: "existing-agent",
          orgId: "org_auth_ctx",
      }),
    },
  );

  const body = await assertJsonResponse<Record<string, unknown>>(response, 409);

  assert.match(JSON.stringify(body), /exist|conflict|duplicate/i);
});

test("POST /v1/identities retries an overloaded pre-create read then returns 503 with Retry-After", async () => {
  const storage = createTestStorage();
  let attempts = 0;
  storage.identities.findDuplicate = async () => {
    attempts += 1;
    throw new Error("DB is overloaded. Requests queued for too long.");
  };
  const app = createTestApp({}, { storage });
  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "overload-probe", sponsorId: "user_sponsor_1" },
      { Authorization: `Bearer ${createAuthToken()}` },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{
    attempts?: number;
    code?: string;
    operation?: string;
    retryable?: boolean;
    requestId?: string;
  }>(response, 503);
  assert.equal(attempts, 3, "the read should receive the bounded retry budget");
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body.code, "storage_overloaded");
  assert.equal(body.retryable, true);
  assert.equal(body.operation, "identities.find_duplicate");
  assert.equal(body.attempts, 3);
  assert.equal(typeof body.requestId, "string");
});

test("POST /v1/identities protects org-budget reads with the same overload response", async () => {
  const storage = createTestStorage();
  let attempts = 0;
  storage.identities.findDuplicate = async () => null;
  storage.identities.loadOrgBudget = async () => {
    attempts += 1;
    throw new Error("Requests queued for too long because the database is overloaded");
  };
  const app = createTestApp({}, { storage });
  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "budget-overload-probe", sponsorId: "user_sponsor_1" },
      { Authorization: `Bearer ${createAuthToken()}` },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ code?: string }>(response, 503);
  assert.equal(attempts, 3);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(body.code, "storage_overloaded");
});

test("POST /v1/identities never retries a create that may already have committed", async () => {
  const storage = createTestStorage();
  const create = storage.identities.create.bind(storage.identities);
  let attempts = 0;
  storage.identities.create = async (identity) => {
    attempts += 1;
    await create(identity);
    throw Object.assign(new Error("database write failed"), { code: "SQLITE_BUSY" });
  };
  const app = createTestApp({}, { storage });

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "committed-before-overload", sponsorId: "user_sponsor_1" },
      { Authorization: `Bearer ${createAuthToken()}` },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{
    attempts?: number;
    code?: string;
    operation?: string;
  }>(response, 503);
  assert.equal(attempts, 1);
  assert.equal(body.code, "storage_overloaded");
  assert.equal(body.operation, "identities.create");
  assert.equal(body.attempts, 1);
  const stored = await storage.identities.list("org_auth_ctx");
  assert.equal(stored.filter((identity) => identity.name === "committed-before-overload").length, 1);
});

test("POST /v1/identities returns 429 before storage reads after the API-key/org limit is exhausted", async () => {
  const storage = createTestStorage();
  let duplicateReads = 0;
  const findDuplicate = storage.identities.findDuplicate.bind(storage.identities);
  storage.identities.findDuplicate = async (...args) => {
    duplicateReads += 1;
    return findDuplicate(...args);
  };
  const app = createTestApp({}, {
    storage,
    identityCreateRateLimiter: new FixedWindowRateLimiter(1, 60_000),
  });
  const headers = { Authorization: `Bearer ${createAuthToken()}` };

  const first = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "rate-limit-first", sponsorId: "user_sponsor_1" },
      headers,
    ),
    undefined,
    app.bindings,
  );
  assert.equal(first.status, 201);

  const second = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "rate-limit-second", sponsorId: "user_sponsor_1" },
      headers,
    ),
    undefined,
    app.bindings,
  );
  const body = await assertJsonResponse<{ code?: string; retryable?: boolean }>(second, 429);

  assert.equal(body.code, "rate_limited");
  assert.equal(body.retryable, true);
  assert.match(second.headers.get("Retry-After") ?? "", /^\d+$/);
  assert.equal(second.headers.get("RateLimit-Remaining"), "0");
  assert.equal(duplicateReads, 1, "rejected requests must not reach identity storage");
});

test("the global error handler preserves rate-limit errors as 429 responses", async () => {
  const decision = {
    allowed: false,
    limit: 1,
    remaining: 0,
    resetAt: Date.now() + 60_000,
    retryAfterSeconds: 60,
  };
  const app = createTestApp({}, {
    identityCreateRateLimiter: {
      consume() {
        throw new RateLimitExceededError(decision);
      },
    },
  });

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "global-rate-limit", sponsorId: "user_sponsor_1" },
      { Authorization: `Bearer ${createAuthToken()}` },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ code?: string }>(response, 429);
  assert.equal(body.code, "rate_limited");
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("RateLimit-Remaining"), "0");
});

test("POST /v1/identities returns 503 with capacity envelope when storage.identities.create throws StorageCapacityExhaustedError", async () => {
  // Verifies that StorageCapacityExhaustedError thrown from storage.identities.create()
  // propagates correctly: the route catch block re-throws it (not swallowed as 500),
  // and app.onError handles it via storageCapacityResponse → 503 with Retry-After.
  // This is the server-side assertion that the 503 route mapping fix is correct.
  const storage = createTestStorage();
  storage.identities.create = async () => {
    throw new StorageCapacityExhaustedError("post-auth mint capacity exhausted (status 429)");
  };
  const app = createTestApp({}, { storage });

  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      { name: "capacity-probe", sponsorId: "user_sponsor_1" },
      { Authorization: `Bearer ${createAuthToken()}` },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{
    code?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    requestId?: string;
  }>(response, 503);
  assert.equal(body.code, "storage_capacity_exhausted", "capacity envelope code");
  assert.equal(body.retryable, true, "capacity envelope must be retryable");
  assert.ok(response.headers.get("Retry-After"), "Retry-After header must be present");
  assert.equal(response.headers.get("Cache-Control"), "no-store", "Cache-Control must be no-store");
});
