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
  listRevokedTokenIds,
  seedActiveTokens,
  seedStoredIdentities,
} from "./test-helpers.js";

type SuspendReason = "manual" | "budget_exceeded" | "parent_suspended";

type ActiveToken = {
  id: string;
  identityId: string;
};

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

async function createSuspendHarness({
  claims,
  identities = [],
  activeTokens = [],
}: {
  claims?: Partial<RelayAuthTokenClaims>;
  identities?: StoredIdentity[];
  activeTokens?: ActiveToken[];
} = {}) {
  const app = createTestApp();
  await seedStoredIdentities(app, identities);

  for (const [identityId, tokenIds] of Object.entries(
    activeTokens.reduce<Record<string, string[]>>((acc, token) => {
      const list = acc[token.identityId] ?? [];
      list.push(token.id);
      acc[token.identityId] = list;
      return acc;
    }, {}),
  )) {
    await seedActiveTokens(app, identityId, tokenIds);
  }

  return {
    app,
    authHeaders: {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    } satisfies HeadersInit,
  };
}

async function postSuspendIdentity(
  identityId: string,
  body: unknown,
  {
    claims,
    identities = [],
    activeTokens = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
    activeTokens?: ActiveToken[];
  } = {},
) {
  const harness = await createSuspendHarness({ claims, identities, activeTokens });
  const request = createTestRequest(
    "POST",
    `/v1/identities/${identityId}/suspend`,
    body,
    harness.authHeaders,
  );

  return {
    response: await harness.app.request(request, undefined, harness.app.bindings),
    app: harness.app,
  };
}

async function listAuditEventReasons(app: ReturnType<typeof createTestApp>): Promise<string[]> {
  const result = await app.storage.DB.prepare(`
    SELECT reason
    FROM audit_events
    ORDER BY created_at ASC, id ASC
  `).all<{ reason?: string }>();

  return result.results
    .map((row) => row.reason)
    .filter((reason): reason is string => typeof reason === "string");
}

test("POST /v1/identities/:id/suspend with reason returns 200 and sets suspended fields", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_manual_200",
    orgId: "org_suspend_manual",
    status: "active",
  });

  const { response, app } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const persisted = await app.storage.identities.get(identity.id);

  assert.equal(body.id, identity.id);
  assert.equal(body.status, "suspended");
  assert.equal(body.suspendReason, "manual");
  assertIsoTimestamp(body.suspendedAt, "suspendedAt");
  assertIsoTimestamp(body.updatedAt, "updatedAt");
  assert.equal(persisted?.status, "suspended");
  assert.equal(persisted?.suspendReason, "manual");
});

test("POST /v1/identities/:id/suspend returns 400 when reason is missing", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_missing_reason",
    orgId: "org_suspend_validation",
  });

  const { response } = await postSuspendIdentity(identity.id, {}, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.match(body.error, /reason/i);
});

test("POST /v1/identities/:id/suspend returns 404 for a non-existent identity", async () => {
  const { response } = await postSuspendIdentity("agent_suspend_missing_404", { reason: "manual" });

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/suspend returns 409 when the identity is already suspended", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_already_suspended",
    orgId: "org_suspend_conflict",
    status: "suspended",
    suspendedAt: "2026-03-10T09:00:00.000Z",
    suspendReason: "manual",
  });

  const { response } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /already|suspend/i);
});

test("POST /v1/identities/:id/suspend returns 409 when the identity is retired", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_retired",
    orgId: "org_suspend_retired",
    status: "retired",
  });

  const { response } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /retired|cannot/i);
});

test("POST /v1/identities/:id/suspend revokes all active tokens for the identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_revoke_tokens",
    orgId: "org_suspend_revoke",
  });
  const activeTokens: ActiveToken[] = [
    { id: "jti_access_1", identityId: identity.id },
    { id: "jti_access_2", identityId: identity.id },
    { id: "jti_refresh_3", identityId: identity.id },
  ];

  const { response, app } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
    activeTokens,
  });

  await assertJsonResponse<StoredIdentity>(response, 200);
  assert.deepEqual(
    await listRevokedTokenIds(app),
    activeTokens.map((token) => token.id).sort(),
  );
});

test("POST /v1/identities/:id/suspend cascades suspension to sub-agents spawned by the identity", async () => {
  const parent = createStoredIdentity({
    id: "agent_suspend_parent",
    orgId: "org_suspend_cascade",
    sponsorChain: ["user_owner_1", "agent_root_1", "agent_suspend_parent"],
  });
  const childA = createStoredIdentity({
    id: "agent_suspend_child_a",
    orgId: parent.orgId,
    sponsorId: parent.id,
    sponsorChain: ["user_owner_1", "agent_root_1", parent.id, "agent_suspend_child_a"],
  });
  const childB = createStoredIdentity({
    id: "agent_suspend_child_b",
    orgId: parent.orgId,
    sponsorId: parent.id,
    sponsorChain: ["user_owner_1", "agent_root_1", parent.id, "agent_suspend_child_b"],
  });

  const { response, app } = await postSuspendIdentity(parent.id, { reason: "manual" }, {
    claims: { org: parent.orgId },
    identities: [parent, childA, childB],
  });

  await assertJsonResponse<StoredIdentity>(response, 200);

  const parentAfter = await app.storage.identities.get(parent.id);
  const childAAfter = await app.storage.identities.get(childA.id);
  const childBAfter = await app.storage.identities.get(childB.id);

  assert.equal(parentAfter?.status, "suspended");
  assert.equal(parentAfter?.suspendReason, "manual");
  assert.equal(childAAfter?.status, "suspended");
  assert.equal(childAAfter?.suspendReason, "parent_suspended");
  assert.equal(childBAfter?.status, "suspended");
  assert.equal(childBAfter?.suspendReason, "parent_suspended");
});

test("POST /v1/identities/:id/suspend writes audit events with manual, budget_exceeded, and parent_suspended reasons", async () => {
  const parent = createStoredIdentity({
    id: "agent_audit_parent",
    orgId: "org_suspend_audit",
  });
  const child = createStoredIdentity({
    id: "agent_audit_child",
    orgId: parent.orgId,
    sponsorId: parent.id,
    sponsorChain: ["user_owner_1", "agent_root_1", parent.id, "agent_audit_child"],
  });
  const budgetExceededIdentity = createStoredIdentity({
    id: "agent_audit_budget",
    orgId: parent.orgId,
  });

  const manualFlow = await postSuspendIdentity(parent.id, { reason: "manual" }, {
    claims: { org: parent.orgId },
    identities: [parent, child],
  });
  const budgetFlow = await postSuspendIdentity(budgetExceededIdentity.id, { reason: "budget_exceeded" }, {
    claims: { org: budgetExceededIdentity.orgId },
    identities: [budgetExceededIdentity],
  });

  await assertJsonResponse<StoredIdentity>(manualFlow.response, 200);
  await assertJsonResponse<StoredIdentity>(budgetFlow.response, 200);

  const manualReasons = await listAuditEventReasons(manualFlow.app);
  const budgetReasons = await listAuditEventReasons(budgetFlow.app);

  assert.equal(manualReasons.includes("manual"), true);
  assert.equal(manualReasons.includes("parent_suspended"), true);
  assert.equal(budgetReasons.includes("budget_exceeded"), true);
});
