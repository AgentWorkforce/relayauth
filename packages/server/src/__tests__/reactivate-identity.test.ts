import assert from "node:assert/strict";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { StoredIdentity } from "../durable-objects/identity-do.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
  seedStoredIdentities,
} from "./test-helpers.js";

function assertIsoTimestamp(value: string | undefined, fieldName: string): void {
  assert.equal(typeof value, "string", `${fieldName} should be set`);
  assert.equal(Number.isNaN(Date.parse(value as string)), false, `${fieldName} should be an ISO timestamp`);
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_owner_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, "agent_root_1", base.id],
    workspaceId: overrides.workspaceId ?? "ws_test",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

async function postReactivateIdentity(
  identityId: string,
  {
    claims,
    identities = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
  } = {},
): Promise<{
  response: Response;
  app: ReturnType<typeof createTestApp>;
}> {
  const app = createTestApp();
  await seedStoredIdentities(app, identities);
  const request = createTestRequest(
    "POST",
    `/v1/identities/${identityId}/reactivate`,
    undefined,
    {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    },
  );

  return {
    response: await app.request(request, undefined, app.bindings),
    app,
  };
}

test("POST /v1/identities/:id/reactivate returns 200 with the updated identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_200",
    orgId: "org_reactivate_200",
    status: "suspended",
    suspendedAt: "2026-03-24T09:00:00.000Z",
    suspendReason: "manual_review",
    updatedAt: "2026-03-24T09:00:00.000Z",
  });

  const { response } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.name, identity.name);
  assert.equal(body.type, identity.type);
  assert.equal(body.orgId, identity.orgId);
});

test('POST /v1/identities/:id/reactivate sets status back to "active"', async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_status",
    orgId: "org_reactivate_status",
    status: "suspended",
    suspendedAt: "2026-03-24T09:10:00.000Z",
    suspendReason: "budget_exceeded",
  });

  const { response, app } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const stored = await app.storage.identities.get(identity.id);

  assert.equal(body.status, "active");
  assert.equal(stored?.status, "active");
});

test("POST /v1/identities/:id/reactivate clears suspendReason and suspendedAt", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_clears_suspend_fields",
    orgId: "org_reactivate_clears_suspend_fields",
    status: "suspended",
    suspendedAt: "2026-03-24T09:20:00.000Z",
    suspendReason: "manual_review",
  });

  const { response, app } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const stored = await app.storage.identities.get(identity.id);

  assert.equal(body.suspendedAt, undefined);
  assert.equal(body.suspendReason, undefined);
  assert.equal(stored?.suspendedAt, undefined);
  assert.equal(stored?.suspendReason, undefined);
});

test("POST /v1/identities/:id/reactivate returns 404 for a non-existent identity", async () => {
  const { response } = await postReactivateIdentity("agent_reactivate_missing");

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/reactivate returns 409 if the identity is already active", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_already_active",
    orgId: "org_reactivate_already_active",
    status: "active",
  });

  const { response } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /already|active/i);
});

test("POST /v1/identities/:id/reactivate returns 409 if the identity is retired", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_retired",
    orgId: "org_reactivate_retired",
    status: "retired",
  });

  const { response } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /retired|cannot/i);
});

test("POST /v1/identities/:id/reactivate updates the updatedAt timestamp", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_updates_timestamp",
    orgId: "org_reactivate_updates_timestamp",
    status: "suspended",
    suspendedAt: "2026-03-24T09:30:00.000Z",
    suspendReason: "manual_review",
    updatedAt: "2026-03-24T09:30:00.000Z",
  });

  const { response, app } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const stored = await app.storage.identities.get(identity.id);

  assertIsoTimestamp(body.updatedAt, "updatedAt");
  assert.notEqual(body.updatedAt, identity.updatedAt);
  assert.equal(Date.parse(body.updatedAt) >= Date.parse(identity.updatedAt), true);
  assert.equal(stored?.updatedAt, body.updatedAt);
});
