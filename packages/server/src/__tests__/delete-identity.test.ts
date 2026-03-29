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

type ActiveToken = {
  id: string;
  identityId: string;
};

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

function createAuthHeaders(claims?: Partial<RelayAuthTokenClaims>): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken(claims)}`,
    "X-Confirm-Delete": "true",
  };
}

async function createDeleteHarness({
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
    authHeaders: createAuthHeaders(claims),
  };
}

async function requestIdentityRoute(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  headers: HeadersInit,
): Promise<Response> {
  const request = createTestRequest(method, path, undefined, headers);
  return app.request(request, undefined, app.bindings);
}

async function deleteIdentity(
  identityId: string,
  {
    claims,
    identities = [],
    activeTokens = [],
    headers,
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
    activeTokens?: ActiveToken[];
    headers?: HeadersInit;
  } = {},
) {
  const harness = await createDeleteHarness({ claims, identities, activeTokens });
  const response = await requestIdentityRoute(
    harness.app,
    "DELETE",
    `/v1/identities/${identityId}?confirm=true`,
    headers ?? harness.authHeaders,
  );

  return {
    response,
    app: harness.app,
    authHeaders: harness.authHeaders,
  };
}

test("DELETE /v1/identities/:id with confirm=true returns 204", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_204",
    orgId: "org_delete_204",
    status: "active",
  });

  const { response } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("DELETE /v1/identities/:id requires X-Confirm-Delete: true header", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_requires_header",
    orgId: "org_delete_requires_header",
  });

  const { response } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
    headers: {
      Authorization: `Bearer ${generateTestToken({ org: identity.orgId })}`,
    },
  });

  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.match(body.error, /confirm|x-confirm-delete/i);
});

test("DELETE /v1/identities/:id returns 404 for a non-existent identity", async () => {
  const { response } = await deleteIdentity("agent_delete_missing");

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("DELETE /v1/identities/:id hard deletes the identity from storage", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_hard_delete",
    orgId: "org_delete_hard_delete",
    status: "suspended",
    suspendedAt: "2026-03-20T10:00:00.000Z",
    suspendReason: "manual_review",
  });

  const { response, app } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  assert.equal(response.status, 204);
  assert.equal(await app.storage.identities.get(identity.id), null);
});

test("GET /v1/identities/:id returns 404 after DELETE /v1/identities/:id", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_then_get",
    orgId: "org_delete_then_get",
    status: "active",
  });
  const harness = await createDeleteHarness({
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const deleteResponse = await requestIdentityRoute(
    harness.app,
    "DELETE",
    `/v1/identities/${identity.id}?confirm=true`,
    harness.authHeaders,
  );
  assert.equal(deleteResponse.status, 204);

  const getResponse = await requestIdentityRoute(
    harness.app,
    "GET",
    `/v1/identities/${identity.id}`,
    {
      Authorization: `Bearer ${generateTestToken({ org: identity.orgId })}`,
    },
  );
  const body = await assertJsonResponse<{ error: string }>(getResponse, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("DELETE /v1/identities/:id revokes all active tokens for the identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_revoke_tokens",
    orgId: "org_delete_revoke",
    status: "retired",
  });
  const activeTokens: ActiveToken[] = [
    { id: "jti_delete_access_1", identityId: identity.id },
    { id: "jti_delete_access_2", identityId: identity.id },
    { id: "jti_delete_refresh_3", identityId: identity.id },
  ];

  const { response, app } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
    activeTokens,
  });

  assert.equal(response.status, 204);
  assert.deepEqual(
    await listRevokedTokenIds(app),
    activeTokens.map((token) => token.id).sort(),
  );
});

test("DELETE /v1/identities/:id can delete identities in active, suspended, and retired states", async () => {
  const statuses = ["active", "suspended", "retired"] as const;

  for (const status of statuses) {
    const identity = createStoredIdentity({
      id: `agent_delete_status_${status}`,
      orgId: "org_delete_all_statuses",
      status,
      ...(status === "suspended"
        ? {
            suspendedAt: "2026-03-22T08:30:00.000Z",
            suspendReason: "manual_review",
          }
        : {}),
    });

    const { response, app } = await deleteIdentity(identity.id, {
      claims: { org: identity.orgId },
      identities: [identity],
    });

    assert.equal(response.status, 204, `expected ${status} identity delete to return 204`);
    assert.equal(await app.storage.identities.get(identity.id), null);
  }
});
