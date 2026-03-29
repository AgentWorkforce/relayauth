import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { AgentIdentity, CreateIdentityInput, RelayAuthTokenClaims } from "@relayauth/types";
import type { IdentityBudget, StoredIdentity } from "../storage/identity-types.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
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

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

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

  return signHs256(payload as Record<string, unknown>, "dev-secret");
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
