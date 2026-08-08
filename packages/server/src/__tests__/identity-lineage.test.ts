import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { StoredIdentity } from "../storage/identity-types.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
  seedStoredIdentity,
} from "./test-helpers.js";

type CreatedIdentity = {
  id: string;
  orgId: string;
  workspaceId: string;
  sponsorId: string;
  sponsorChain: string[];
};

type WorkspaceTokenResponse = {
  key: string;
};

type IdentityLineageResponse = {
  identityId: string;
  orgId: string;
  workspaceId: string;
  sponsorId: string;
  sponsorChain: string[];
  createdAt: string;
  tokens: Array<{
    tokenId: string;
    identityId: string;
    orgId: string;
    workspaceId: string;
    sponsorId: string;
    sponsorChain: string[];
    tokenType: "access" | "refresh";
    createdAt: string;
  }>;
};

function authorizationToken(): string {
  return generateTestToken({
    sub: "agent_lineage_operator",
    org: "org_lineage",
    wks: "ws_lineage",
    sponsorId: "user_lineage_owner",
    sponsorChain: ["user_lineage_owner", "agent_lineage_operator"],
    scopes: [
      "relayauth:identity:manage:*",
      "relayauth:identity:read:*",
      "relayauth:api-key:manage:*",
      "relayauth:token:create:*",
    ],
  } satisfies Partial<RelayAuthTokenClaims>);
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${authorizationToken()}` };
}

test("identity lineage survives a SQLite server restart without reading an issued JWT", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "relayauth-lineage-"));
  const dbPath = join(directory, "relayauth.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const firstStorage = createSqliteStorage(dbPath);
  const firstApp = createTestApp({}, { storage: firstStorage });

  const createIdentityResponse = await firstApp.request(
    createTestRequest(
      "POST",
      "/v1/identities",
      {
        name: "lineage-worker",
        sponsorId: "user_lineage_owner",
        workspaceId: "ws_lineage",
        scopes: ["relayauth:identity:read:*"],
      },
      authHeaders(),
    ),
    undefined,
    firstApp.bindings,
  );
  const identity = await assertJsonResponse<CreatedIdentity>(
    createIdentityResponse,
    201,
  );

  const workspaceTokenResponse = await firstApp.request(
    createTestRequest(
      "POST",
      "/v1/tokens/workspace",
      {
        workspaceId: "ws_lineage",
        scopes: ["relayauth:token:create:*", "relayauth:identity:read:*"],
      },
      authHeaders(),
    ),
    undefined,
    firstApp.bindings,
  );
  const workspaceToken = await assertJsonResponse<WorkspaceTokenResponse>(
    workspaceTokenResponse,
    201,
  );

  const mintAgentTokenResponse = await firstApp.request(
    createTestRequest(
      "POST",
      "/v1/tokens/agent",
      {
        agentId: identity.id,
        scopes: ["relayauth:identity:read:*"],
      },
      { "x-api-key": workspaceToken.key },
    ),
    undefined,
    firstApp.bindings,
  );
  assert.equal(mintAgentTokenResponse.status, 201);

  const queryLineage = async (
    app: ReturnType<typeof createTestApp>,
  ): Promise<IdentityLineageResponse> => {
    const response = await app.request(
      createTestRequest(
        "GET",
        `/v1/identities/${identity.id}/lineage`,
        undefined,
        authHeaders(),
      ),
      undefined,
      app.bindings,
    );
    return assertJsonResponse<IdentityLineageResponse>(response, 200);
  };

  const beforeRestart = await queryLineage(firstApp);
  assert.equal(beforeRestart.identityId, identity.id);
  assert.equal(beforeRestart.orgId, "org_lineage");
  assert.equal(beforeRestart.workspaceId, "ws_lineage");
  assert.equal(beforeRestart.sponsorId, "user_lineage_owner");
  assert.deepEqual(beforeRestart.sponsorChain, [
    "user_lineage_owner",
    "agent_lineage_operator",
    identity.id,
  ]);
  assert.equal(beforeRestart.tokens.length, 2);
  assert.deepEqual(
    beforeRestart.tokens.map((token) => token.tokenType).sort(),
    ["access", "refresh"],
  );
  for (const token of beforeRestart.tokens) {
    assert.equal(token.identityId, identity.id);
    assert.equal(token.orgId, "org_lineage");
    assert.equal(token.workspaceId, "ws_lineage");
    assert.equal(token.sponsorId, "user_lineage_owner");
    assert.deepEqual(token.sponsorChain, beforeRestart.sponsorChain);
  }

  await firstApp.close();
  const restartedStorage = createSqliteStorage(dbPath);
  const restartedApp = createTestApp({}, { storage: restartedStorage });
  t.after(async () => restartedApp.close());
  const afterRestart = await queryLineage(restartedApp);
  assert.deepEqual(afterRestart, beforeRestart);
});

test("lineage endpoint never exposes an identity from another organization", async () => {
  const app = createTestApp();
  const base = generateTestIdentity({
    id: "agent_other_org",
    orgId: "org_other",
  });
  const otherOrganizationIdentity: StoredIdentity = {
    ...base,
    workspaceId: "ws_other",
    sponsorId: "user_other_owner",
    sponsorChain: ["user_other_owner", "agent_other_org"],
  };
  await seedStoredIdentity(app, otherOrganizationIdentity);

  const response = await app.request(
    createTestRequest(
      "GET",
      "/v1/identities/agent_other_org/lineage",
      undefined,
      { Authorization: `Bearer ${generateTestToken({ org: "org_lineage" })}` },
    ),
    undefined,
    app.bindings,
  );

  assert.equal(response.status, 404);
});
