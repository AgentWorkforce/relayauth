import assert from "node:assert/strict";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { StoredIdentity } from "../storage/identity-types.js";
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

type RetireRequest = {
  reason?: string;
};

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

async function createRetireHarness({
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

async function requestLifecycleRoute(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body: unknown,
  headers: HeadersInit,
): Promise<Response> {
  const request = createTestRequest(method, path, body, headers);
  return app.request(request, undefined, app.bindings);
}

async function postRetireIdentity(
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
  const harness = await createRetireHarness({ claims, identities, activeTokens });
  const response = await requestLifecycleRoute(
    harness.app,
    "POST",
    `/v1/identities/${identityId}/retire`,
    body,
    harness.authHeaders,
  );

  return {
    response,
    app: harness.app,
    authHeaders: harness.authHeaders,
  };
}

test("POST /v1/identities/:id/retire returns 200 with the updated identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_200",
    orgId: "org_retire_200",
    status: "active",
    updatedAt: "2026-03-24T09:00:00.000Z",
  });

  const { response } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.name, identity.name);
  assert.equal(body.type, identity.type);
  assert.equal(body.orgId, identity.orgId);
});

test('POST /v1/identities/:id/retire sets status to "retired" permanently', async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_status",
    orgId: "org_retire_status",
    status: "active",
    updatedAt: "2026-03-24T09:10:00.000Z",
  });

  const { response, app } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const stored = await app.storage.identities.get(identity.id);

  assert.equal(body.status, "retired");
  assertIsoTimestamp(body.updatedAt, "updatedAt");
  assert.notEqual(body.updatedAt, identity.updatedAt);
  assert.equal(stored?.status, "retired");
});

test("POST /v1/identities/:id/retire accepts an optional reason in the body", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_reason",
    orgId: "org_retire_reason",
    status: "active",
  });

  const body = { reason: "manual_cleanup" } satisfies RetireRequest;
  const result = await postRetireIdentity(identity.id, body, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const responseBody = await assertJsonResponse<StoredIdentity>(result.response, 200);

  assert.equal(responseBody.status, "retired");
});

test("POST /v1/identities/:id/retire returns 404 for a non-existent identity", async () => {
  const { response } = await postRetireIdentity("agent_retire_missing", undefined);

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/retire returns 409 if the identity is already retired", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_already_retired",
    orgId: "org_retire_already_retired",
    status: "retired",
  });

  const { response } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /already|retired/i);
});

test("POST /v1/identities/:id/retire can retire an active identity directly", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_active",
    orgId: "org_retire_active",
    status: "active",
  });

  const { response, app } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.status, "retired");
  assert.equal((await app.storage.identities.get(identity.id))?.status, "retired");
});

test("POST /v1/identities/:id/retire can retire a suspended identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_suspended",
    orgId: "org_retire_suspended",
    status: "suspended",
    suspendedAt: "2026-03-24T09:20:00.000Z",
    suspendReason: "manual_review",
  });

  const { response, app } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const stored = await app.storage.identities.get(identity.id);

  assert.equal(body.status, "retired");
  assert.equal(body.suspendedAt, undefined);
  assert.equal(body.suspendReason, undefined);
  assert.equal(stored?.status, "retired");
  assert.equal(stored?.suspendedAt, undefined);
  assert.equal(stored?.suspendReason, undefined);
});

test("POST /v1/identities/:id/retire revokes all active tokens for the identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_revoke_tokens",
    orgId: "org_retire_revoke",
    status: "active",
  });
  const activeTokens: ActiveToken[] = [
    { id: "jti_access_1", identityId: identity.id },
    { id: "jti_access_2", identityId: identity.id },
    { id: "jti_refresh_3", identityId: identity.id },
  ];

  const { response, app } = await postRetireIdentity(identity.id, undefined, {
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

test("a retired identity cannot be reactivated after POST /v1/identities/:id/retire", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_then_reactivate",
    orgId: "org_retire_then_reactivate",
    status: "active",
  });
  const harness = await createRetireHarness({
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const retireResponse = await requestLifecycleRoute(
    harness.app,
    "POST",
    `/v1/identities/${identity.id}/retire`,
    undefined,
    harness.authHeaders,
  );
  await assertJsonResponse<StoredIdentity>(retireResponse, 200);

  const reactivateResponse = await requestLifecycleRoute(
    harness.app,
    "POST",
    `/v1/identities/${identity.id}/reactivate`,
    undefined,
    harness.authHeaders,
  );
  const reactivateBody = await assertJsonResponse<{ error: string }>(reactivateResponse, 409);

  assert.match(reactivateBody.error, /retired|reactivate|cannot/i);
});
