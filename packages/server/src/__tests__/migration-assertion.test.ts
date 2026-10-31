import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { TokenVerifier } from "@relayauth/sdk";
import type { RelayAuthTokenClaims } from "@relayauth/types";

import { extractPrefix, generateApiKey, hashApiKey } from "../lib/api-keys.js";
import {
  canonicalMigrationJson,
  migrationBackfillBaseReadIdentity,
  migrationBackfillUploadIdentity,
  deriveMigrationGrantPlan,
  MAX_MIGRATION_GRANT_SERIALIZED_BYTES,
  MAX_MIGRATION_GRANT_SOURCE_USERS,
  migrationAllowedPairHash,
  migrationGrantSerializedBytes,
  migrationUploadIdentity,
} from "../lib/migration-plan.js";
import type { ApiKeyKind } from "../storage/api-key-types.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import type { MigrationGrant } from "../storage/interface.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
  seedStoredIdentity,
  TEST_RS256_PUBLIC_KEY_PEM,
} from "./test-helpers.js";

type TestApp = ReturnType<typeof createTestApp>;
type ErrorBody = { error?: string; code?: string };
type GrantResponse = {
  grantId: string;
  orgId: string;
  apiKeyId: string;
  planDigest: string;
  audience: string;
  allowedPairs: Array<{ sourceUserId: string; workspaceId: string }>;
  planEntries: number;
  notAfter: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};
type AssertionResponse = {
  accessToken: string;
  accessTokenExpiresAt: string;
  tokenType: "Bearer";
  refreshToken?: string;
};

const ORG = "org_migration";
const MIGRATION_SCOPE = "relayauth:assertion:create:migration";
const RELAYHISTORY_SCOPE = "relayauth:assertion:create:relayhistory";
const MANAGE_SCOPE = "relayauth:api-key:manage:*";
const AUDIENCE = "https://ingest.96bulls.example";
const NONCE = "nonce_0123456789abcdef";
const ALICE_KEY =
  "v1/ws=ws_alice/m=machine-a/h=codex/d=2026/10/30/s=session-a/manifest.json";
const BOB_KEY =
  "v1/ws=ws_bob/m=machine-b/h=claude/d=2026/10/30/s=session-b/manifest.json";

function createIdentity(
  id: string,
  overrides: Partial<StoredIdentity> = {},
): StoredIdentity {
  const base = generateTestIdentity({
    id,
    name: id,
    type: "human",
    orgId: ORG,
    ...overrides,
  });
  return {
    ...base,
    sponsorId: overrides.sponsorId ?? id,
    sponsorChain: overrides.sponsorChain ?? [id],
    workspaceId: overrides.workspaceId ?? "ws_migration",
  };
}

function adminHeaders(
  overrides: Partial<RelayAuthTokenClaims> = {},
): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken({
      sub: "user_admin",
      org: ORG,
      wks: "ws_admin",
      sponsorId: "user_admin",
      sponsorChain: ["user_admin"],
      scopes: [MANAGE_SCOPE],
      ...overrides,
    })}`,
  };
}

async function seedApiKey(
  app: TestApp,
  options: { orgId?: string; scopes?: string[]; kind?: ApiKeyKind } = {},
): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const stored = await app.storage.apiKeys.create({
    orgId: options.orgId ?? ORG,
    name: "migration-export",
    prefix: extractPrefix(key),
    keyHash: hashApiKey(key),
    scopes: options.scopes ?? [MIGRATION_SCOPE],
    ...(options.kind
      ? { kind: options.kind, workspaceId: "ws_migration" }
      : {}),
  });
  return { id: stored.id, key };
}

async function createHarness(
  bindings: Parameters<typeof createTestApp>[0] = {},
) {
  const app = createTestApp({
    RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS: "true",
    ...bindings,
  });
  await seedStoredIdentity(app, createIdentity("user_alice"));
  await seedStoredIdentity(app, createIdentity("user_bob"));
  await seedStoredIdentity(app, createIdentity("user_carol"));
  await seedStoredIdentity(
    app,
    createIdentity("user_other_org", { orgId: "org_other" }),
  );
  await seedStoredIdentity(
    app,
    createIdentity("agent_not_human", { type: "agent" }),
  );
  await seedStoredIdentity(app, createIdentity("user_ambiguous"));
  await seedStoredIdentity(app, createIdentity("relay_user_ambiguous"));
  const migrationKey = await seedApiKey(app);
  return { app, migrationKey };
}

function plan(
  overrides: { orgId?: string; aliceUser?: string; aliceWorkspace?: string } = {},
) {
  const orgId = overrides.orgId ?? ORG;
  const aliceUser = overrides.aliceUser ?? "user_alice";
  const aliceWorkspace = overrides.aliceWorkspace ?? "ws_alice";
  // The path itself is canonical even when the plan's explicit identity field
  // uses the accepted one-prefix RelayAuth alias.
  const aliceKey = ALICE_KEY;
  return {
    exported_at: "2026-10-30T00:00:00.000Z",
    manifests: [
      {
        key: aliceKey,
        org_id: orgId,
        workspace_id: aliceWorkspace,
        source_user_id: aliceUser,
        session: {
          machine_id: "machine-a",
          harness: "codex",
          session_id: "session-a",
          started_at: "2026-10-30T00:00:00.000Z",
        },
        state: "closed",
        chunks: [
          { seq: 0, epoch: 0, start_offset: 0, bytes: 512, sha256: "1".repeat(64), records: 1 },
        ],
      },
      {
        key: BOB_KEY,
        org_id: orgId,
        workspace_id: "ws_bob",
        source_user_id: "user_bob",
        session: {
          machine_id: "machine-b",
          harness: "claude",
          session_id: "session-b",
          started_at: "2026-10-30T00:01:00.000Z",
        },
        state: "open",
        chunks: [
          { seq: 0, epoch: 3, start_offset: 0, bytes: 1024, sha256: "2".repeat(64), records: 2 },
        ],
      },
    ],
  };
}

function planWithDistinctSourceUsers(count: number) {
  return {
    exported_at: "2026-10-30T00:00:00.000Z",
    manifests: Array.from({ length: count }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return {
        key: `v1/ws=ws-${suffix}/m=machine-${suffix}/h=codex/d=2026/10/30/s=session-${suffix}/manifest.json`,
        org_id: ORG,
        workspace_id: `ws-${suffix}`,
        source_user_id: `user-${suffix}`,
        session: {
          machine_id: `machine-${suffix}`,
          harness: "codex",
          session_id: `session-${suffix}`,
          started_at: "2026-10-30T00:00:00.000Z",
        },
        state: "closed",
        chunks: [
          {
            seq: 0,
            epoch: 0,
            start_offset: 0,
            bytes: 1,
            sha256: "3".repeat(64),
            records: 1,
          },
        ],
      };
    }),
  };
}

function oversizedPlan() {
  const chunks = Array.from({ length: 4096 }, (_, index) => ({
    seq: index,
    epoch: 0,
    start_offset: index,
    bytes: 1,
    sha256: "4".repeat(64),
    records: 1,
  }));
  return {
    exported_at: "2026-10-30T00:00:00.000Z",
    manifests: ["large-a", "large-b"].map((sessionId) => ({
      key: `v1/ws=ws-large/m=machine-large/h=codex/d=2026/10/30/s=${sessionId}/manifest.json`,
      org_id: ORG,
      workspace_id: "ws-large",
      source_user_id: "user_alice",
      session: {
        machine_id: "machine-large",
        harness: "codex",
        session_id: sessionId,
        started_at: "2026-10-30T00:00:00.000Z",
      },
      state: "closed",
      chunks,
    })),
  };
}

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function grantBody(apiKeyId: string, overrides: Record<string, unknown> = {}) {
  return {
    apiKeyId,
    audience: AUDIENCE,
    plan: plan(),
    notAfter: futureIso(3600),
    ...overrides,
  };
}

async function request(
  app: TestApp,
  method: string,
  path: string,
  body: unknown,
  headers: HeadersInit,
): Promise<Response> {
  return app.request(
    createTestRequest(method, path, body, headers),
    undefined,
    app.bindings,
  );
}

async function createGrant(
  app: TestApp,
  apiKeyId: string,
  overrides: Record<string, unknown> = {},
): Promise<GrantResponse> {
  return assertJsonResponse<GrantResponse>(
    await request(app, "POST", "/v1/migration-grants", grantBody(apiKeyId, overrides), adminHeaders()),
    201,
  );
}

function mintBody(
  grantId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    grantId,
    sourceUserId: "user_alice",
    workspaceId: "ws_alice",
    upload: { key: ALICE_KEY },
    nonce: NONCE,
    ...overrides,
  };
}

async function mint(
  app: TestApp,
  key: string,
  body: Record<string, unknown>,
) {
  return request(app, "POST", "/v1/tokens/migration-assertion", body, {
    "x-api-key": key,
  });
}

async function expectError(response: Response, status: number, code: string) {
  await assertJsonResponse<ErrorBody>(response, status, (body) => {
    assert.equal(body.code, code);
  });
}

function decodeClaims(token: string): RelayAuthTokenClaims {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as RelayAuthTokenClaims;
}

function verifySignature(token: string): boolean {
  const [header, payload, signature] = token.split(".");
  return crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    TEST_RS256_PUBLIC_KEY_PEM,
    Buffer.from(signature ?? "", "base64url"),
  );
}

test("contract-v1 vectors match the courier fixture exactly", () => {
  const grantId = "mgr_00000000000000000000000000000000";
  const manifests = [
    {
      key: "v1/ws=ws_synthetic/m=machine-a/h=claude/d=2026/10/25/s=session-a/manifest.json",
      org_id: "org_synthetic",
      workspace_id: "ws_synthetic",
      source_user_id: "user_synthetic_a",
      session: { machine_id: "machine-a", harness: "claude", session_id: "session-a", started_at: "2026-10-25T18:01:58.000Z" },
      state: "closed",
      chunks: [
        { seq: 0, epoch: 0, start_offset: 0, bytes: 4194000, sha256: "bc94be8d405bbe519e9d806b1ae895b0a07e95f57f2492d312175a588eaeab1c", records: 900 },
        { seq: 1, epoch: 0, start_offset: 4194000, bytes: 1234, sha256: "aeba0a6a51348457def7e70f1a6766d7b655d3e0461f98b7d09d47afd6f1cb82", records: 3 },
      ],
    },
    {
      key: "v1/ws=ws_synthetic/m=unknown-origin-42/h=codex/d=2026/01/02/s=019a1f3c-8e2b-7c41-9d3a-5b6f0e2a7c18/manifest.json",
      org_id: "org_synthetic",
      workspace_id: "ws_synthetic",
      source_user_id: "user_synthetic_b",
      session: { machine_id: "unknown-origin-42", harness: "codex", session_id: "019a1f3c-8e2b-7c41-9d3a-5b6f0e2a7c18", started_at: "2026-01-02T00:00:00.000Z" },
      state: "open",
      chunks: [
        { seq: 0, epoch: 0, start_offset: 0, bytes: 512, sha256: "5c294de0de9d05e67c33daec1a2d80576fe47253586e1641ddbf598083d4968e", records: 1 },
      ],
    },
  ];
  const derived = deriveMigrationGrantPlan({
    grantId,
    orgId: "org_synthetic",
    plan: { exported_at: "2026-10-30T00:00:00.000Z", manifests },
  });
  assert.equal(derived.planDigest, "a6682d4deeb479a42d8abf4c0dae89ddf39744916a0d4148bdb40ec702c20df1");
  assert.deepEqual(
    derived.plan.manifests.map((entry) => entry.content_sha256),
    ["ae06338e9635e6940349cd3996467a103f166db6ee2005151a7512da8c9417c4", "972b971dab6ee818f3a033fd9d039fb1d7c2fefcc1dc219c246ff8efe3ae86a0"],
  );
  assert.deepEqual(
    derived.plan.manifests.map((entry) => migrationUploadIdentity(entry, derived.planDigest).entry_sha256),
    ["89619b0b561b6867ac663a71748855c50b9f1cebc47941e9ae6bc066bdbbdb79", "b9b2c7501e295fe40d2b22be791ab99a22746800233f37b8f8104bd001c7676a"],
  );
  assert.equal(
    migrationGrantSerializedBytes(derived.plan, derived.allowedPairs),
    1695,
  );
  assert.ok(1695 < MAX_MIGRATION_GRANT_SERIALIZED_BYTES);
});

test("grant stores a canonical plan and only exact sorted pairs", async () => {
  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id, {
    plan: plan({ aliceUser: "relay_user_alice", aliceWorkspace: "relay_ws_alice" }),
  });
  assert.match(grant.grantId, /^mgr_[0-9a-f]{32}$/u);
  assert.deepEqual(grant.allowedPairs, [
    { sourceUserId: "user_alice", workspaceId: "ws_alice" },
    { sourceUserId: "user_bob", workspaceId: "ws_bob" },
  ]);
  assert.equal(grant.planEntries, 2);
  const stored = await app.storage.migrationGrants!.get(grant.grantId);
  assert.deepEqual(stored?.allowedPairs, grant.allowedPairs);
  assert.equal(stored?.plan.manifests[0]?.source_user_id, "user_alice");
  assert.equal(stored?.plan.manifests[0]?.workspace_id, "ws_alice");
  assert.equal(stored?.plan.manifests[0]?.org_id, ORG);

  const row = await app.storage.DB.prepare(
    "SELECT metadata_json FROM audit_logs WHERE resource = 'migration-grant' AND result = 'allowed'",
  ).first<{ metadata_json: string }>();
  const metadata = JSON.parse(row?.metadata_json ?? "{}") as Record<string, string>;
  assert.equal(metadata.allowedPairHash, migrationAllowedPairHash(grant.allowedPairs));
  assert.equal(
    metadata.allowedPairHash,
    "1ed480655dfbd300ba853689606be060d259db0714dd11d339159c038860372d",
  );
  assert.equal(
    metadata.allowedPairHash,
    migrationAllowedPairHash([...grant.allowedPairs].reverse()),
    "pair audit hash must not depend on caller/manifest order",
  );
  assert.equal(metadata.allowedPairCount, "2");
  assert.equal(metadata.planEntries, "2");
  assert.equal("plan" in metadata, false);
  assert.equal("allowedPairs" in metadata, false);
  assert.equal("sourceUserId" in metadata, false);
});

test("grant creation preserves dedicated-key, admin and plan safety gates", async (t) => {
  const { app, migrationKey } = await createHarness();
  const withoutScope = await seedApiKey(app, { scopes: [RELAYHISTORY_SCOPE] });
  const extraScope = await seedApiKey(app, {
    scopes: [MIGRATION_SCOPE, MANAGE_SCOPE],
  });
  const workspaceToken = await seedApiKey(app, {
    kind: "workspace_token",
  });
  const otherOrg = await seedApiKey(app, { orgId: "org_other" });
  const revokedKey = await seedApiKey(app);
  await app.storage.apiKeys.revoke(revokedKey.id, new Date().toISOString());
  const cases: Array<
    [string, string, Record<string, unknown>, HeadersInit, number, string]
  > = [
    ["missing literal scope", withoutScope.id, {}, adminHeaders(), 400, "migration_scope_missing"],
    ["extra scope", extraScope.id, {}, adminHeaders(), 400, "migration_key_not_dedicated"],
    ["workspace token", workspaceToken.id, {}, adminHeaders(), 400, "migration_key_not_dedicated"],
    ["cross-org key", otherOrg.id, {}, adminHeaders(), 404, "api_key_not_found"],
    ["revoked key", revokedKey.id, {}, adminHeaders(), 409, "api_key_revoked"],
    ["cross-org plan", migrationKey.id, { plan: plan({ orgId: "org_other" }) }, adminHeaders(), 400, "plan_org_mismatch"],
    ["source user is not human", migrationKey.id, { plan: plan({ aliceUser: "agent_not_human" }) }, adminHeaders(), 403, "source_user_not_human"],
    ["source user belongs to another org", migrationKey.id, { plan: plan({ aliceUser: "user_other_org" }) }, adminHeaders(), 403, "source_user_org_mismatch"],
    ["source user is absent", migrationKey.id, { plan: plan({ aliceUser: "user_missing" }) }, adminHeaders(), 403, "source_user_not_found"],
    ["source user alias is ambiguous", migrationKey.id, { plan: plan({ aliceUser: "user_ambiguous" }) }, adminHeaders(), 403, "source_user_ambiguous"],
    ["source user lookup budget", migrationKey.id, { plan: planWithDistinctSourceUsers(MAX_MIGRATION_GRANT_SOURCE_USERS + 1) }, adminHeaders(), 400, "migration_plan_source_user_limit"],
    ["serialized D1 row budget", migrationKey.id, { plan: oversizedPlan() }, adminHeaders(), 400, "migration_plan_too_large"],
    ["overlong grant", migrationKey.id, { notAfter: futureIso(8 * 24 * 3600) }, adminHeaders(), 400, "invalid_not_after"],
    ["unprivileged caller", migrationKey.id, {}, adminHeaders({ scopes: [MIGRATION_SCOPE] }), 403, "insufficient_scope"],
  ];
  for (const [name, apiKeyId, override, headers, status, code] of cases) {
    await t.test(name, async () => {
      await expectError(
        await request(app, "POST", "/v1/migration-grants", grantBody(apiKeyId, override), headers),
        status,
        code,
      );
    });
  }
  const grantCount = await app.storage.DB.prepare(
    "SELECT COUNT(*) AS count FROM migration_grants",
  ).first<{ count: number }>();
  assert.equal(grantCount?.count, 0);
});

test("issuer derives and signs upload identity from the stored exact pair", async () => {
  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id);
  const response = await assertJsonResponse<AssertionResponse>(
    await mint(
      app,
      migrationKey.key,
      mintBody(grant.grantId, {
        sourceUserId: "relay_user_alice",
        workspaceId: "relay_ws_alice",
      }),
    ),
    201,
  );
  assert.equal(response.refreshToken, undefined);
  assert.equal(verifySignature(response.accessToken), true);
  const claims = decodeClaims(response.accessToken);
  assert.equal(claims.org, ORG);
  assert.equal(claims.wks, "ws_alice");
  assert.equal(claims.sponsorId, "user_alice");
  assert.deepEqual(claims.aud, [AUDIENCE]);
  assert.deepEqual(claims.scopes, ["rth:sync"]);
  assert.equal(claims.token_type, "access");
  assert.equal(claims.meta?.planDigest, grant.planDigest);
  const stored = await app.storage.migrationGrants!.get(grant.grantId);
  assert.deepEqual(claims.meta?.upload, migrationUploadIdentity(stored!.plan.manifests[0]!, grant.planDigest));
  assert.ok(claims.exp - claims.iat <= 60);
  assert.ok(claims.exp * 1000 <= Date.parse(grant.notAfter));
  assert.equal(
    (
      await request(app, "POST", "/v1/tokens/refresh", {
        refreshToken: response.accessToken,
      })
    ).status,
    401,
    "a migration assertion cannot enter the refresh-token flow",
  );
});

test("cross-pair, key, plan and client identity tampering fail closed", async (t) => {
  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id);
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ["cross pair", { workspaceId: "ws_bob" }, 403, "migration_pair_not_allowed"],
    ["other pair key", { upload: { key: BOB_KEY } }, 403, "migration_pair_not_allowed"],
    ["fresh machine key", { upload: { key: ALICE_KEY.replace("machine-a", "machine-x") } }, 403, "migration_upload_not_allowed"],
    ["client digest", { planDigest: grant.planDigest }, 400, "invalid_request"],
    ["client content", { upload: { key: ALICE_KEY, content_sha256: "0".repeat(64) } }, 400, "invalid_upload_selector"],
    ["client identity", { uploadIdentity: { key: ALICE_KEY } }, 400, "invalid_request"],
  ];
  for (const [name, override, status, code] of cases) {
    await t.test(name, async () => {
      await expectError(await mint(app, migrationKey.key, mintBody(grant.grantId, override)), status, code);
    });
  }

  await app.storage.DB.prepare(
    "UPDATE migration_grants SET plan_digest = ? WHERE grant_id = ?",
  ).bind("0".repeat(64), grant.grantId).run();
  const originalError = console.error;
  console.error = () => {};
  try {
    await expectError(await mint(app, migrationKey.key, mintBody(grant.grantId)), 404, "migration_grant_not_found");
  } finally {
    console.error = originalError;
  }

  const contentGrant = await createGrant(app, migrationKey.id);
  const row = await app.storage.DB.prepare(
    "SELECT plan_json FROM migration_grants WHERE grant_id = ?",
  ).bind(contentGrant.grantId).first<{ plan_json: string }>();
  const storedPlan = JSON.parse(row!.plan_json) as {
    manifests: Array<{ chunks: Array<{ sha256: string }> }>;
  };
  storedPlan.manifests[0]!.chunks[0]!.sha256 = "f".repeat(64);
  await app.storage.DB.prepare(
    "UPDATE migration_grants SET plan_json = ? WHERE grant_id = ?",
  ).bind(JSON.stringify(storedPlan), contentGrant.grantId).run();
  console.error = () => {};
  try {
    await expectError(
      await mint(app, migrationKey.key, mintBody(contentGrant.grantId)),
      404,
      "migration_grant_not_found",
    );
  } finally {
    console.error = originalError;
  }
});

test("default-off dedicated key, revoke and no-refresh gates remain closed", async () => {
  for (const flag of [undefined, "false"]) {
    const disabled = await createHarness({
      RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS: flag,
    });
    await expectError(
      await request(disabled.app, "POST", "/v1/migration-grants", grantBody(disabled.migrationKey.id), adminHeaders()),
      403,
      "migration_assertions_disabled",
    );
  }

  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id);
  const wildcard = await seedApiKey(app, { scopes: ["relayauth:assertion:create:*"] });
  await expectError(await mint(app, wildcard.key, mintBody(grant.grantId)), 403, "assertion_key_required");
  const other = await seedApiKey(app);
  await expectError(await mint(app, other.key, mintBody(grant.grantId)), 403, "migration_grant_key_mismatch");

  const disabledApp = createTestApp(
    { RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS: "false" },
    { storage: app.storage },
  );
  await expectError(
    await mint(disabledApp, migrationKey.key, mintBody(grant.grantId)),
    403,
    "migration_assertions_disabled",
  );
  const revoked = await request(disabledApp, "POST", `/v1/migration-grants/${grant.grantId}/revoke`, undefined, adminHeaders());
  assert.equal(revoked.status, 200);
  await expectError(await mint(app, migrationKey.key, mintBody(grant.grantId)), 403, "migration_grant_revoked");
  await expectError(
    await request(app, "POST", `/v1/migration-grants/${grant.grantId}/revoke`, undefined, adminHeaders()),
    409,
    "migration_grant_revoked",
  );
});

test("grant revocation and its audit row roll back atomically", async () => {
  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id);
  await app.storage.DB.prepare(`
    CREATE TRIGGER fail_migration_grant_revoke_audit
    BEFORE INSERT ON audit_logs
    WHEN NEW.action = 'migration_grant.revoked'
    BEGIN
      SELECT RAISE(ABORT, 'fixture revoke audit failure');
    END
  `).run();

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      (
        await request(
          app,
          "POST",
          `/v1/migration-grants/${grant.grantId}/revoke`,
          undefined,
          adminHeaders(),
        )
      ).status,
      500,
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(
    (await app.storage.migrationGrants!.get(grant.grantId))?.revokedAt,
    undefined,
  );
  const revokeAuditCount = await app.storage.DB.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'migration_grant.revoked'",
  ).first<{ count: number }>();
  assert.equal(revokeAuditCount?.count, 0);
});

test("mint admission, TTL, nonce, expiry and persistence failures stay fail closed", async (t) => {
  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id);
  const workspaceToken = await seedApiKey(app, { kind: "workspace_token" });
  const otherOrgKey = await seedApiKey(app, { orgId: "org_other" });
  const cases: Array<[string, Promise<Response>, number, string]> = [
    [
      "bearer cannot substitute for dedicated key",
      request(app, "POST", "/v1/tokens/migration-assertion", mintBody(grant.grantId), adminHeaders({ scopes: [MIGRATION_SCOPE] })),
      403,
      "assertion_key_required",
    ],
    ["workspace token", mint(app, workspaceToken.key, mintBody(grant.grantId)), 403, "assertion_key_required"],
    ["other org", mint(app, otherOrgKey.key, mintBody(grant.grantId)), 404, "migration_grant_not_found"],
    ["unknown grant", mint(app, migrationKey.key, mintBody("mgr_00000000000000000000000000000001")), 404, "migration_grant_not_found"],
    ["short nonce", mint(app, migrationKey.key, mintBody(grant.grantId, { nonce: "short" })), 400, "invalid_nonce"],
    ["zero TTL", mint(app, migrationKey.key, mintBody(grant.grantId, { expiresIn: 0 })), 400, "invalid_expires_in"],
    ["long TTL", mint(app, migrationKey.key, mintBody(grant.grantId, { expiresIn: 61 })), 400, "invalid_expires_in"],
  ];
  for (const [name, response, status, code] of cases) {
    await t.test(name, async () => expectError(await response, status, code));
  }

  await app.storage.DB.prepare(
    "UPDATE migration_grants SET not_after = ? WHERE grant_id = ?",
  ).bind(futureIso(-1), grant.grantId).run();
  await expectError(
    await mint(app, migrationKey.key, mintBody(grant.grantId)),
    403,
    "migration_grant_expired",
  );

  const liveGrant = await createGrant(app, migrationKey.id);
  app.storage.tokens.persistIssuedWithAudit = async () => {
    throw new Error("simulated atomic persistence failure");
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      (await mint(app, migrationKey.key, mintBody(liveGrant.grantId))).status,
      500,
    );
  } finally {
    console.error = originalError;
  }
  const tokenCount = await app.storage.DB.prepare(
    "SELECT COUNT(*) AS count FROM tokens",
  ).first<{ count: number }>();
  assert.equal(tokenCount?.count, 0);
});

test("source identity is rechecked and relayhistory admission stays separate", async () => {
  const { app, migrationKey } = await createHarness();
  const grant = await createGrant(app, migrationKey.id);
  await app.storage.identities.suspend("user_alice", "test");
  await expectError(await mint(app, migrationKey.key, mintBody(grant.grantId)), 403, "source_user_inactive");

  const historyKey = await seedApiKey(app, { scopes: [RELAYHISTORY_SCOPE] });
  await expectError(await mint(app, historyKey.key, mintBody(grant.grantId)), 403, "insufficient_scope");
  await expectError(
    await request(app, "POST", "/v1/tokens/relayhistory-assertion", {
      orgId: ORG,
      workspaceId: "ws_alice",
      sponsorId: "user_alice",
      scopes: ["rth:sync"],
    }, { "x-api-key": migrationKey.key }),
    403,
    "insufficient_scope",
  );
});

test("migration grant storage verifies the canonical persisted plan", async (t) => {
  for (const forceMemory of [false, true]) {
    await t.test(forceMemory ? "memory" : "sqlite", async () => {
      const storage = createSqliteStorage(":memory:", { forceMemory });
      try {
        const grantId = `mgr_${crypto.randomUUID().replaceAll("-", "")}`;
        const derived = deriveMigrationGrantPlan({ grantId, orgId: ORG, plan: plan() });
        const grant: MigrationGrant = {
          grantId,
          orgId: ORG,
          apiKeyId: "ak_migration",
          planDigest: derived.planDigest,
          plan: derived.plan,
          audience: AUDIENCE,
          allowedPairs: derived.allowedPairs,
          notAfter: futureIso(3600),
          createdBy: "user_admin",
          createdAt: new Date().toISOString(),
        };
        const auditEntry = {
          id: crypto.randomUUID(),
          action: "migration_grant.created" as const,
          identityId: "user_admin",
          orgId: ORG,
          resource: "migration-grant",
          result: "allowed" as const,
          metadata: { grantId },
          timestamp: new Date().toISOString(),
        };
        await storage.migrationGrants!.createWithAudit({ grant, auditEntry });
        assert.deepEqual(await storage.migrationGrants!.get(grantId), grant);
        await assert.rejects(
          storage.migrationGrants!.createWithAudit({
            grant,
            auditEntry: { ...auditEntry, id: crypto.randomUUID() },
          }),
        );
      } finally {
        await storage.close();
      }
    });
  }
});

// --- Plan entry v2 (spec of record: 96BullSessions main @ f67f741, #86) ----

const LIVE_KEY =
  "v1/ws=ws_alice/m=machine-live/h=claude/d=2026/10/30/s=session-live/manifest.json";
const LIVE_BASE = {
  revision: 7,
  version: "\"5f3c-live-v7\"",
  owner: "machine-live",
  writer: "machine-live",
  chunk_count: 4,
  epoch: 0,
  content_sha256: "0f0d280d26f82b57da5f44bac5284c5941b62479ad959a44dff869f24d3904e1",
};

function liveBackfill(overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    kind: "backfill",
    key: LIVE_KEY,
    org_id: ORG,
    workspace_id: "ws_alice",
    source_user_id: "user_alice",
    session: {
      machine_id: "machine-live",
      harness: "claude",
      session_id: "session-live",
      started_at: "2026-10-30T08:00:00.000Z",
    },
    format: "ndjson",
    chunks: [
      { start_offset: 0, bytes: 2048, sha256: "f".repeat(64), records: 12 },
      { start_offset: 2048, bytes: 777, sha256: "e".repeat(64), records: 3 },
    ],
    ...overrides,
  };
}

function v2PlanBody() {
  return { ...plan(), backfills: [liveBackfill()] };
}

async function jwksVerifier(app: TestApp, audience: string[]) {
  const jwks = await (await app.request("/.well-known/jwks.json", undefined, app.bindings)).json();
  return new TokenVerifier({
    jwksUrl: `data:application/json,${encodeURIComponent(JSON.stringify(jwks))}`,
    audience,
  });
}

test("v2: grant creation stores v1 byte for byte for absent and empty backfills", async () => {
  const { app, migrationKey } = await createHarness();
  const absent = await createGrant(app, migrationKey.id);
  const empty = await createGrant(app, migrationKey.id, {
    plan: { ...plan(), backfills: [] },
  });
  const rows = await Promise.all(
    [absent, empty].map((grant) =>
      app.storage.DB.prepare(
        "SELECT plan_json FROM migration_grants WHERE grant_id = ?",
      ).bind(grant.grantId).first<{ plan_json: string }>(),
    ),
  );
  for (const [grant, row] of [[absent, rows[0]], [empty, rows[1]]] as const) {
    const expected = deriveMigrationGrantPlan({ grantId: grant.grantId, orgId: ORG, plan: plan() });
    assert.equal(grant.planDigest, expected.planDigest);
    assert.equal(
      row?.plan_json,
      canonicalMigrationJson(expected.plan),
      "stored plan_json is the canonical v1 plan",
    );
    const stored = JSON.parse(row!.plan_json) as Record<string, unknown>;
    assert.equal(stored.v, 1);
    assert.equal("backfills" in stored, false);
    assert.equal(grant.planEntries, 2);
  }
  const audits = await app.storage.DB.prepare(
    "SELECT metadata_json FROM audit_logs WHERE action = 'migration_grant.created' AND result = 'allowed'",
  ).all<{ metadata_json: string }>();
  for (const row of audits.results ?? []) {
    const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
    assert.equal("planVersion" in metadata, false);
    assert.equal("backfillEntries" in metadata, false);
  }
});

test("v2: a v2 grant mints the base-read capability and the commit identity", async () => {
  const { app, migrationKey } = await createHarness({
    RELAYAUTH_ENABLE_MIGRATION_BASE_READ: "true",
  });
  const grant = await createGrant(app, migrationKey.id, { plan: v2PlanBody() });
  assert.equal(grant.planEntries, 3);
  const stored = await app.storage.migrationGrants!.get(grant.grantId);
  assert.equal(stored?.plan.v, 2);
  const entry = stored!.plan.v === 2 ? stored!.plan.backfills[0]! : undefined;
  assert.ok(entry);

  // Base-read capability: its own token class.
  const readResponse = await assertJsonResponse<AssertionResponse>(
    await mint(app, migrationKey.key, mintBody(grant.grantId, {
      upload: { key: LIVE_KEY, kind: "backfill_base_read" },
    })),
    201,
  );
  assert.equal(verifySignature(readResponse.accessToken), true);
  assert.equal(readResponse.refreshToken, undefined);
  const read = decodeClaims(readResponse.accessToken);
  assert.equal(read.sub, "agent_relayhistory_migration_base_read");
  assert.deepEqual(read.aud, [`${AUDIENCE}/v1/pipeline/manifests/base`]);
  assert.deepEqual(read.scopes, ["rth:migration_base_read"]);
  assert.equal(read.meta?.tokenClass, "migration_base_read");
  assert.match(read.jti, /^mbr_[0-9a-f]{32}$/u);
  assert.ok(read.exp - read.iat <= 30);
  assert.equal(read.org, ORG);
  assert.equal(read.wks, "ws_alice");
  assert.equal(read.sponsorId, "user_alice");
  assert.deepEqual(read.meta?.read, migrationBackfillBaseReadIdentity(entry!, grant.planDigest));
  assert.equal("upload" in (read.meta ?? {}), false, "meta.upload is absent on a base-read");
  assert.equal(read.meta?.grantId, grant.grantId);
  assert.equal(read.meta?.planDigest, grant.planDigest);
  assert.equal(read.meta?.nonce, NONCE);

  // Commit identity: the upload assertion's class, with the request's base.
  const commitResponse = await assertJsonResponse<AssertionResponse>(
    await mint(app, migrationKey.key, mintBody(grant.grantId, {
      upload: { key: LIVE_KEY, base: LIVE_BASE },
    })),
    201,
  );
  const commit = decodeClaims(commitResponse.accessToken);
  assert.equal(commit.sub, "agent_relayhistory_migration");
  assert.deepEqual(commit.aud, [AUDIENCE]);
  assert.deepEqual(commit.scopes, ["rth:sync"]);
  assert.equal(commit.meta?.tokenClass, "migration_assertion");
  assert.match(commit.jti, /^tok_/u);
  assert.equal("read" in (commit.meta ?? {}), false);
  assert.deepEqual(
    commit.meta?.upload,
    migrationBackfillUploadIdentity(entry!, grant.planDigest, LIVE_BASE),
  );

  // A v1 manifest of the same v2 plan still signs the v1 identity.
  const v1Response = await assertJsonResponse<AssertionResponse>(
    await mint(app, migrationKey.key, mintBody(grant.grantId)),
    201,
  );
  const v1Claims = decodeClaims(v1Response.accessToken);
  assert.equal("v" in (v1Claims.meta?.upload as object), false);
  assert.equal((v1Claims.meta?.upload as { plan_digest: string }).plan_digest, grant.planDigest);

  // Issuer audit (#86 §8): kind, key hash, entry digest, base revision only.
  const rows = await app.storage.DB.prepare(
    "SELECT resource, metadata_json FROM audit_logs WHERE action = 'token.issued' AND result = 'allowed' ORDER BY timestamp",
  ).all<{ resource: string; metadata_json: string }>();
  const audits = (rows.results ?? []).map((row) => ({
    resource: row.resource,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
  }));
  const byJti = Object.fromEntries(audits.map((a) => [a.metadata.tokenId, a]));
  const readAudit = byJti[read.jti]!;
  const commitAudit = byJti[commit.jti]!;
  const v1Audit = byJti[v1Claims.jti]!;
  assert.equal(readAudit.resource, "migration-base-read");
  assert.equal(readAudit.metadata.upload_kind, "backfill_base_read");
  assert.equal(readAudit.metadata.entry_sha256, read.meta?.read && (read.meta.read as { entry_sha256: string }).entry_sha256);
  assert.equal(readAudit.metadata.base_revision, undefined);
  assert.equal(commitAudit.resource, "migration-assertion");
  assert.equal(commitAudit.metadata.upload_kind, "backfill");
  assert.equal(commitAudit.metadata.base_revision, "7");
  for (const audit of [readAudit, commitAudit]) {
    // v2 rows: no raw nonce; correlated by tokenId (the jti).
    assert.equal("nonce" in audit.metadata, false);
    assert.equal(JSON.stringify(audit.metadata).includes(NONCE), false);
  }
  // Ruling: the v1 mint audit row is exactly #111's.
  assert.equal(v1Audit.resource, "migration-assertion");
  assert.deepEqual(Object.keys(v1Audit.metadata).sort(), [
    "actorOrgId", "grantId", "grantedScopes", "nonce", "pairHash",
    "planDigest", "tokenId", "uploadKeyHash",
  ]);
  for (const audit of audits) {
    const text = JSON.stringify(audit.metadata);
    assert.equal(text.includes(LIVE_BASE.content_sha256), false, "no base content in audit");
    assert.equal(text.includes("5f3c-live-v7"), false, "no base version in audit");
    assert.equal(text.includes(readResponse.accessToken), false);
  }

  // Two-way token/audience matrix at the verifier: an upload verifier
  // (pinned to the grant origin) refuses the base-read capability, and a
  // base-route verifier refuses every upload assertion.
  const uploadVerifier = await jwksVerifier(app, [AUDIENCE]);
  const baseVerifier = await jwksVerifier(app, [`${AUDIENCE}/v1/pipeline/manifests/base`]);
  await assert.rejects(uploadVerifier.verify(readResponse.accessToken));
  assert.equal((await baseVerifier.verify(readResponse.accessToken)).sub, read.sub);
  for (const token of [commitResponse.accessToken, v1Response.accessToken]) {
    assert.equal((await uploadVerifier.verify(token)).sub, "agent_relayhistory_migration");
    await assert.rejects(baseVerifier.verify(token));
  }
  // Nor does RelayAuth itself accept the capability as a credential.
  assert.equal(
    (await request(app, "POST", "/v1/tokens/refresh", { refreshToken: readResponse.accessToken }, {})).status,
    401,
  );
  const asBearer = await request(app, "POST", "/v1/migration-grants", grantBody(migrationKey.id), {
    Authorization: `Bearer ${readResponse.accessToken}`,
  });
  assert.ok(asBearer.status === 401 || asBearer.status === 403, String(asBearer.status));
});

test("v2: each upload form only reaches its own list, pair and shape", async (t) => {
  const { app, migrationKey } = await createHarness({
    RELAYAUTH_ENABLE_MIGRATION_BASE_READ: "true",
  });
  const grant = await createGrant(app, migrationKey.id, { plan: v2PlanBody() });
  const v1Only = await createGrant(app, migrationKey.id);
  const cases: Array<[string, string, Record<string, unknown>, number, string]> = [
    ["v1 form on a backfill key", grant.grantId, { upload: { key: LIVE_KEY } }, 403, "migration_upload_not_allowed"],
    ["base-read on a v1 key", grant.grantId, { upload: { key: ALICE_KEY, kind: "backfill_base_read" } }, 403, "migration_upload_not_allowed"],
    ["commit on a v1 key", grant.grantId, { upload: { key: ALICE_KEY, base: LIVE_BASE } }, 403, "migration_upload_not_allowed"],
    ["base-read on a v1 plan", v1Only.grantId, { upload: { key: LIVE_KEY, kind: "backfill_base_read" } }, 403, "migration_upload_not_allowed"],
    ["backfill key for another pair", grant.grantId, { sourceUserId: "user_bob", workspaceId: "ws_bob", upload: { key: LIVE_KEY, kind: "backfill_base_read" } }, 403, "migration_pair_not_allowed"],
    ["unknown kind", grant.grantId, { upload: { key: LIVE_KEY, kind: "backfill" } }, 400, "invalid_upload_selector"],
    ["kind and base together", grant.grantId, { upload: { key: LIVE_KEY, kind: "backfill_base_read", base: LIVE_BASE } }, 400, "invalid_upload_selector"],
    ["tenant override", grant.grantId, { upload: { key: LIVE_KEY, kind: "backfill_base_read", org_id: "org_other" } }, 400, "invalid_upload_selector"],
    ["identity field", grant.grantId, { upload: { key: LIVE_KEY, base: LIVE_BASE, entry_sha256: "0".repeat(64) } }, 400, "invalid_upload_selector"],
    ["migration owner base", grant.grantId, { upload: { key: LIVE_KEY, base: { ...LIVE_BASE, owner: `migration:${grant.grantId}` } } }, 400, "invalid_upload_selector"],
    ["unsafe revision", grant.grantId, { upload: { key: LIVE_KEY, base: { ...LIVE_BASE, revision: Number.MAX_SAFE_INTEGER } } }, 400, "invalid_upload_selector"],
    ["extra base key", grant.grantId, { upload: { key: LIVE_KEY, base: { ...LIVE_BASE, format: "ndjson" } } }, 400, "invalid_upload_selector"],
  ];
  for (const [name, grantId, override, status, code] of cases) {
    await t.test(name, async () => {
      await expectError(await mint(app, migrationKey.key, mintBody(grantId, override)), status, code);
    });
  }
  const denied = await app.storage.DB.prepare(
    "SELECT metadata_json FROM audit_logs WHERE resource = 'migration-assertion' AND result = 'denied'",
  ).all<{ metadata_json: string }>();
  const deniedRows = (denied.results ?? []).map(
    (row) => JSON.parse(row.metadata_json) as Record<string, string>,
  );
  assert.equal(deniedRows.length, cases.length, "every refusal is audited");
  for (const row of deniedRows) {
    // v2 selectors carry their form and the key hash, never the raw key.
    assert.equal(JSON.stringify(row).includes(LIVE_KEY), false);
  }
  assert.ok(deniedRows.some((row) => row.upload_kind === "backfill_base_read"));
  assert.ok(deniedRows.some((row) => row.upload_kind === "backfill"));
  const tokens = await app.storage.DB.prepare("SELECT COUNT(*) AS count FROM tokens").first<{ count: number }>();
  assert.equal(tokens?.count, 0);
});

test("v2: grant creation refuses malformed backfills and cross-list keys", async (t) => {
  const { app, migrationKey } = await createHarness();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["supplied backfill_sha256", liveBackfill({ backfill_sha256: "0".repeat(64) })],
    ["missing records", liveBackfill({ chunks: [{ start_offset: 0, bytes: 1, sha256: "f".repeat(64) }] })],
    ["key also a v1 manifest", liveBackfill({
      key: ALICE_KEY,
      session: { machine_id: "machine-a", harness: "codex", session_id: "session-a", started_at: "2026-10-30T00:00:00.000Z" },
    })],
  ];
  for (const [name, backfill] of cases) {
    await t.test(name, async () => {
      await expectError(
        await request(app, "POST", "/v1/migration-grants", grantBody(migrationKey.id, {
          plan: { ...plan(), backfills: [backfill] },
        }), adminHeaders()),
        400,
        "invalid_plan",
      );
    });
  }
  await t.test("backfill source user must be an active human", async () => {
    await expectError(
      await request(app, "POST", "/v1/migration-grants", grantBody(migrationKey.id, {
        plan: { ...plan(), backfills: [liveBackfill({ source_user_id: "agent_not_human" })] },
      }), adminHeaders()),
      403,
      "source_user_not_human",
    );
  });
});

test("v2: base-read issuance is default-off and separately switched", async () => {
  for (const flag of [undefined, "false", "1", "TRUE"]) {
    const { app, migrationKey } = await createHarness(
      flag === undefined ? {} : { RELAYAUTH_ENABLE_MIGRATION_BASE_READ: flag },
    );
    const grant = await createGrant(app, migrationKey.id, { plan: v2PlanBody() });
    await expectError(
      await mint(app, migrationKey.key, mintBody(grant.grantId, {
        upload: { key: LIVE_KEY, kind: "backfill_base_read" },
      })),
      403,
      "migration_base_read_disabled",
    );
    // The commit form and v1 are not gated by it.
    assert.equal(
      (await mint(app, migrationKey.key, mintBody(grant.grantId, {
        upload: { key: LIVE_KEY, base: LIVE_BASE },
      }))).status,
      201,
    );
    assert.equal((await mint(app, migrationKey.key, mintBody(grant.grantId))).status, 201);
  }
  // It never overrides the main switch.
  const off = await createHarness({
    RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS: "false",
    RELAYAUTH_ENABLE_MIGRATION_BASE_READ: "true",
  });
  await expectError(
    await mint(off.app, off.migrationKey.key, mintBody("mgr_00000000000000000000000000000001", {
      upload: { key: LIVE_KEY, kind: "backfill_base_read" },
    })),
    403,
    "migration_assertions_disabled",
  );
});

test("v2: backfill-only grants, and wrong-org backfills are generic with an internal reason", async () => {
  const { app, migrationKey } = await createHarness({
    RELAYAUTH_ENABLE_MIGRATION_BASE_READ: "true",
  });
  const grant = await createGrant(app, migrationKey.id, {
    plan: { exported_at: plan().exported_at, manifests: [], backfills: [liveBackfill()] },
  });
  assert.equal(grant.planEntries, 1);
  assert.deepEqual(grant.allowedPairs, [{ sourceUserId: "user_alice", workspaceId: "ws_alice" }]);
  assert.equal(
    (await mint(app, migrationKey.key, mintBody(grant.grantId, {
      upload: { key: LIVE_KEY, kind: "backfill_base_read" },
    }))).status,
    201,
  );
  await expectError(
    await request(app, "POST", "/v1/migration-grants", grantBody(migrationKey.id, {
      plan: { exported_at: plan().exported_at, manifests: [], backfills: [] },
    }), adminHeaders()),
    400,
    "invalid_plan",
  );

  const wrongOrg = await request(app, "POST", "/v1/migration-grants", grantBody(migrationKey.id, {
    plan: { ...plan(), backfills: [liveBackfill({ org_id: "org_other" })] },
  }), adminHeaders());
  const text = await wrongOrg.text();
  assert.equal(wrongOrg.status, 400);
  assert.equal((JSON.parse(text) as ErrorBody).code, "invalid_plan");
  assert.equal(text.includes("org"), false, "the response does not name the org problem");
  // Two denials can share a millisecond, so select by content, not order.
  const deniedRows = await app.storage.DB.prepare(
    "SELECT metadata_json FROM audit_logs WHERE action = 'migration_grant.created' AND result = 'denied'",
  ).all<{ metadata_json: string }>();
  const denials = (deniedRows.results ?? []).map(
    (row) => JSON.parse(row.metadata_json) as Record<string, string>,
  );
  assert.equal(denials.length, 2);
  const withDetail = denials.filter((metadata) => metadata.detail !== undefined);
  assert.equal(withDetail.length, 1, "only the wrong-org refusal carries a detail");
  assert.equal(withDetail[0]!.reason, "invalid_plan");
  assert.equal(withDetail[0]!.detail, "backfill_org_mismatch");

  // v1 keeps plan_org_mismatch.
  await expectError(
    await request(app, "POST", "/v1/migration-grants", grantBody(migrationKey.id, {
      plan: plan({ orgId: "org_other" }),
    }), adminHeaders()),
    400,
    "plan_org_mismatch",
  );
});
