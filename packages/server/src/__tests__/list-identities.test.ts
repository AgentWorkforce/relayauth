import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIdentity, IdentityStatus, IdentityType, RelayAuthTokenClaims } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
  seedStoredIdentities,
} from "./test-helpers.js";
import type { StoredIdentity } from "../durable-objects/identity-do.js";

type ListIdentitiesResponse = {
  data: AgentIdentity[];
  cursor?: string;
};

function createIdentity(
  index: number,
  overrides: Partial<AgentIdentity> = {},
): AgentIdentity {
  return generateTestIdentity({
    id: overrides.id ?? `agent_${String(index).padStart(3, "0")}`,
    name: overrides.name ?? `Identity ${index}`,
    type: overrides.type ?? "agent",
    orgId: overrides.orgId ?? "org_test",
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? [`scope:${index}`],
    roles: overrides.roles ?? [`role:${index}`],
    metadata: overrides.metadata ?? { index: String(index) },
    createdAt: overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 0, 0, 1000 - index)).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, 0, 1000 - index)).toISOString(),
    ...(overrides.lastActiveAt !== undefined ? { lastActiveAt: overrides.lastActiveAt } : {}),
    ...(overrides.suspendedAt !== undefined ? { suspendedAt: overrides.suspendedAt } : {}),
    ...(overrides.suspendReason !== undefined ? { suspendReason: overrides.suspendReason } : {}),
  });
}

function decodeCursorCandidate(
  value: string,
): { id?: string; createdAt?: string } | null {
  const tryParse = (candidate: string): { id?: string; createdAt?: string } | null => {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      const createdAt =
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : typeof parsed.created_at === "string"
            ? parsed.created_at
            : undefined;

      if (id || createdAt) {
        return { id, createdAt };
      }
    } catch {
      // Fall through to plain-string handling.
    }

    return {
      ...(trimmed ? { id: trimmed, createdAt: trimmed } : {}),
    };
  };

  const direct = tryParse(value);
  if (direct?.id || direct?.createdAt) {
    return direct;
  }

  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const decoded = Buffer.from(value, encoding).toString("utf8");
      const parsed = tryParse(decoded);
      if (parsed?.id || parsed?.createdAt) {
        return parsed;
      }
    } catch {
      // Ignore invalid base64 variants.
    }
  }

  return null;
}

function toStoredIdentity(identity: AgentIdentity): StoredIdentity {
  return {
    ...identity,
    sponsorId: "user_list_owner",
    sponsorChain: ["user_list_owner", "agent_list_parent", identity.id],
    workspaceId: "ws_test",
  };
}

async function listIdentities(
  search = "",
  {
    claims,
    identities = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: AgentIdentity[];
  } = {},
): Promise<Response> {
  const app = createTestApp();
  await seedStoredIdentities(app, identities.map(toStoredIdentity));
  const token = generateTestToken(claims);
  const request = createTestRequest(
    "GET",
    `/v1/identities${search}`,
    undefined,
    {
      Authorization: `Bearer ${token}`,
    },
  );

  return app.request(request, undefined, app.bindings);
}

test("GET /v1/identities returns 200 with { data: [...], cursor?: string }", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_contract_1",
      name: "Contract One",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_contract_2",
      name: "Contract Two",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
  ];

  const response = await listIdentities("", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.ok(Array.isArray(body.data));
  assert.deepEqual(body.data, identities);
  assert.equal("cursor" in body, false);
});

test("GET /v1/identities returns an empty array when no identities exist", async () => {
  const response = await listIdentities();
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body, { data: [] });
});

test("GET /v1/identities returns all identities for the authenticated org", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_org_1",
      orgId: "org_test",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_org_2",
      orgId: "org_test",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(3, {
      id: "agent_other_org",
      orgId: "org_other",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("", {
    claims: { org: "org_test" },
    identities,
  });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_org_1", "agent_org_2"]);
  assert.ok(body.data.every((identity) => identity.orgId === "org_test"));
});

test("GET /v1/identities supports the status=active filter", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_active_1",
      status: "active",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_suspended_1",
      status: "suspended",
      suspendedAt: "2026-03-24T11:59:00.000Z",
      suspendReason: "manual_review",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(3, {
      id: "agent_active_2",
      status: "active",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("?status=active", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_active_1", "agent_active_2"]);
  assert.ok(body.data.every((identity) => identity.status === "active"));
});

test("GET /v1/identities supports the type=agent filter", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_type_agent_1",
      type: "agent",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(2, {
      id: "agent_type_human_1",
      type: "human",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(3, {
      id: "agent_type_service_1",
      type: "service",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("?type=agent", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_type_agent_1"]);
  assert.ok(body.data.every((identity) => identity.type === "agent"));
});

test("GET /v1/identities uses a default limit of 50 results", async () => {
  const identities = Array.from({ length: 60 }, (_, index) =>
    createIdentity(index + 1, {
      id: `agent_default_limit_${String(index + 1).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 60 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 60 - index)).toISOString(),
    }),
  );

  const response = await listIdentities("", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.equal(body.data.length, 50);
  assert.equal(typeof body.cursor, "string");
});

test("GET /v1/identities caps limit at 100 results", async () => {
  const identities = Array.from({ length: 150 }, (_, index) =>
    createIdentity(index + 1, {
      id: `agent_max_limit_${String(index + 1).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 150 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 2, 24, 12, 0, 150 - index)).toISOString(),
    }),
  );

  const response = await listIdentities("?limit=500", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.equal(body.data.length, 100);
  assert.equal(typeof body.cursor, "string");
});

test("GET /v1/identities supports cursor-based pagination", async () => {
  const identities = [
    createIdentity(1, {
      id: "agent_page_1",
      createdAt: "2026-03-24T12:00:04.000Z",
      updatedAt: "2026-03-24T12:00:04.000Z",
    }),
    createIdentity(2, {
      id: "agent_page_2",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(3, {
      id: "agent_page_3",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(4, {
      id: "agent_page_4",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const firstPageResponse = await listIdentities("?limit=2", { identities });
  const firstPage = await assertJsonResponse<ListIdentitiesResponse>(firstPageResponse, 200);

  assert.deepEqual(firstPage.data.map((identity) => identity.id), ["agent_page_1", "agent_page_2"]);
  assert.equal(typeof firstPage.cursor, "string");

  const secondPageResponse = await listIdentities(`?limit=2&cursor=${encodeURIComponent(firstPage.cursor ?? "")}`, {
    identities,
  });
  const secondPage = await assertJsonResponse<ListIdentitiesResponse>(secondPageResponse, 200);

  assert.deepEqual(secondPage.data.map((identity) => identity.id), ["agent_page_3", "agent_page_4"]);
  assert.equal("cursor" in secondPage, false);
});

test("GET /v1/identities sorts results by createdAt descending", async () => {
  const identities = [
    createIdentity(2, {
      id: "agent_newest",
      createdAt: "2026-03-24T12:00:03.000Z",
      updatedAt: "2026-03-24T12:00:03.000Z",
    }),
    createIdentity(3, {
      id: "agent_middle",
      createdAt: "2026-03-24T12:00:02.000Z",
      updatedAt: "2026-03-24T12:00:02.000Z",
    }),
    createIdentity(1, {
      id: "agent_oldest",
      createdAt: "2026-03-24T12:00:01.000Z",
      updatedAt: "2026-03-24T12:00:01.000Z",
    }),
  ];

  const response = await listIdentities("", { identities });
  const body = await assertJsonResponse<ListIdentitiesResponse>(response, 200);

  assert.deepEqual(body.data.map((identity) => identity.id), ["agent_newest", "agent_middle", "agent_oldest"]);
});
