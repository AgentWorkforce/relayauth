import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { RelayAuthTokenClaims } from "@relayauth/types";

import { extractPrefix, generateApiKey, hashApiKey } from "../lib/api-keys.js";
import {
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
import { migrationGrantFingerprintPlan } from "../routes/migration-grants.js";
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

const IDEMPOTENCY_HEADER = "Idempotency-Key";

function newIdempotencyKey(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function grantHeaders(
  idempotencyKey: string = newIdempotencyKey(),
  overrides: Partial<RelayAuthTokenClaims> = {},
): Record<string, string> {
  return {
    ...(adminHeaders(overrides) as Record<string, string>),
    [IDEMPOTENCY_HEADER]: idempotencyKey,
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
    await request(app, "POST", "/v1/migration-grants", grantBody(apiKeyId, overrides), grantHeaders()),
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
        await request(app, "POST", "/v1/migration-grants", grantBody(apiKeyId, override), {
          ...(headers as Record<string, string>),
          [IDEMPOTENCY_HEADER]: newIdempotencyKey(),
        }),
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
      await request(disabled.app, "POST", "/v1/migration-grants", grantBody(disabled.migrationKey.id), grantHeaders()),
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
        const idempotency = {
          keyHash: "a".repeat(64),
          callerId: "user_admin",
          requestFingerprint: "b".repeat(64),
        };
        assert.deepEqual(
          await storage.migrationGrants!.createWithAudit({ grant, auditEntry, idempotency }),
          { outcome: "created", grant },
        );
        assert.deepEqual(await storage.migrationGrants!.get(grantId), grant);
        await assert.rejects(
          storage.migrationGrants!.createWithAudit({
            grant,
            auditEntry: { ...auditEntry, id: crypto.randomUUID() },
            idempotency: { ...idempotency, keyHash: "c".repeat(64) },
          }),
        );
      } finally {
        await storage.close();
      }
    });
  }
});

// --- Idempotent grant creation -------------------------------------------

type GrantCounts = {
  grants: number;
  receipts: number;
  createdAudits: number;
};

async function grantCounts(app: TestApp): Promise<GrantCounts> {
  const one = async (sql: string) =>
    (await app.storage.DB.prepare(sql).first<{ count: number }>())?.count ?? -1;
  return {
    grants: await one("SELECT COUNT(*) AS count FROM migration_grants"),
    receipts: await one(
      "SELECT COUNT(*) AS count FROM migration_grant_idempotency_receipts",
    ),
    createdAudits: await one(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'migration_grant.created' AND result = 'allowed'",
    ),
  };
}

async function deniedCreateAudits(
  app: TestApp,
  reason: string,
): Promise<Array<Record<string, string>>> {
  const rows = await app.storage.DB.prepare(
    "SELECT metadata_json FROM audit_logs WHERE action = 'migration_grant.created' AND result = 'denied'",
  ).all<{ metadata_json: string }>();
  return (rows.results ?? [])
    .map((row) => JSON.parse(row.metadata_json) as Record<string, string>)
    .filter((metadata) => metadata.reason === reason);
}

async function postGrant(
  app: TestApp,
  body: unknown,
  headers: HeadersInit,
): Promise<Response> {
  return request(app, "POST", "/v1/migration-grants", body, headers);
}

async function silenceConsoleError<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = originalError;
  }
}

test("idempotency: a lost create response is recovered by retrying the same key", async () => {
  const { app, migrationKey } = await createHarness();
  const key = newIdempotencyKey();
  const body = grantBody(migrationKey.id);

  const first = await postGrant(app, body, grantHeaders(key));
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("Idempotent-Replayed"), null);
  // The caller never reads this response: it was lost after the commit.
  const committed = (await first.json()) as GrantResponse;

  const retry = await postGrant(app, body, grantHeaders(key));
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get("Idempotent-Replayed"), "true");
  const recovered = (await retry.json()) as GrantResponse;
  assert.deepEqual(recovered, committed, "same grantId, digest and mint state");

  // Equivalent non-canonical spellings of the same request also replay.
  const aliased = await postGrant(
    app,
    {
      ...body,
      plan: plan({ aliceUser: "relay_user_alice", aliceWorkspace: "relay_ws_alice" }),
      // Same instant, written with an explicit offset instead of Z.
      notAfter: body.notAfter.replace(/Z$/u, "+00:00"),
    },
    grantHeaders(key),
  );
  assert.equal(aliased.status, 201);
  assert.deepEqual((await aliased.json()) as GrantResponse, committed);

  assert.deepEqual(await grantCounts(app), {
    grants: 1,
    receipts: 1,
    createdAudits: 1,
  });

  const receipt = await app.storage.DB.prepare(
    "SELECT org_id, caller_id, grant_id FROM migration_grant_idempotency_receipts",
  ).first<{ org_id: string; caller_id: string; grant_id: string }>();
  assert.deepEqual({ ...receipt }, {
    org_id: ORG,
    caller_id: "user_admin",
    grant_id: committed.grantId,
  });

  // The recovered grant is the live one and mints normally.
  assert.equal(
    (await mint(app, migrationKey.key, mintBody(recovered.grantId))).status,
    201,
  );
});

test("idempotency: concurrent same-key creates commit exactly one grant", async (t) => {
  await t.test("http", async () => {
    const { app, migrationKey } = await createHarness();
    const key = newIdempotencyKey();
    const body = grantBody(migrationKey.id);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postGrant(app, body, grantHeaders(key))),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(8).fill(201),
    );
    const grants = (await Promise.all(
      responses.map((response) => response.json()),
    )) as GrantResponse[];
    assert.equal(new Set(grants.map((grant) => grant.grantId)).size, 1);
    assert.equal(new Set(grants.map((grant) => grant.planDigest)).size, 1);
    assert.equal(
      responses.filter((response) => response.headers.get("Idempotent-Replayed") !== "true").length,
      1,
      "exactly one response is the original create",
    );
    assert.deepEqual(await grantCounts(app), {
      grants: 1,
      receipts: 1,
      createdAudits: 1,
    });
  });

  for (const forceMemory of [false, true]) {
    await t.test(`storage race (${forceMemory ? "memory" : "sqlite"})`, async () => {
      const storage = createSqliteStorage(":memory:", { forceMemory });
      try {
        const idempotency = {
          keyHash: "d".repeat(64),
          callerId: "user_admin",
          requestFingerprint: "e".repeat(64),
        };
        const candidates = Array.from({ length: 4 }, () =>
          storageGrantFixture(),
        );
        // Every request passed the pre-create lookup before any committed.
        const results = await Promise.all(
          candidates.map(({ grant, auditEntry }) =>
            storage.migrationGrants!.createWithAudit({ grant, auditEntry, idempotency }),
          ),
        );
        assert.deepEqual(
          results.map((result) => result.outcome),
          ["created", "replayed", "replayed", "replayed"],
        );
        const winner = candidates[0]!.grant.grantId;
        for (const result of results) {
          assert.ok(result.outcome !== "conflict");
          assert.equal(result.grant.grantId, winner);
        }
        for (const loser of candidates.slice(1)) {
          assert.equal(await storage.migrationGrants!.get(loser.grant.grantId), null);
        }
        const conflict = await storage.migrationGrants!.createWithAudit({
          ...storageGrantFixture(),
          idempotency: { ...idempotency, requestFingerprint: "f".repeat(64) },
        });
        assert.deepEqual(conflict, { outcome: "conflict" });
        const audits = await storage.audit.query({ orgId: ORG, limit: 50 });
        assert.equal(
          audits.entries.filter((entry) => entry.action === "migration_grant.created").length,
          1,
        );
      } finally {
        await storage.close();
      }
    });
  }
});

function storageGrantFixture(orgId = ORG) {
  const grantId = `mgr_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = deriveMigrationGrantPlan({ grantId, orgId, plan: plan({ orgId }) });
  const grant: MigrationGrant = {
    grantId,
    orgId,
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
    orgId,
    resource: "migration-grant",
    result: "allowed" as const,
    metadata: { grantId },
    timestamp: new Date().toISOString(),
  };
  return { grant, auditEntry };
}

test("idempotency: same key with a different request is an audited 409", async (t) => {
  const { app, migrationKey } = await createHarness();
  const otherKey = await seedApiKey(app);
  const key = newIdempotencyKey();
  const body = grantBody(migrationKey.id);
  const original = await assertJsonResponse<GrantResponse>(
    await postGrant(app, body, grantHeaders(key)),
    201,
  );
  const receipt = await app.storage.DB.prepare(
    "SELECT key_hash FROM migration_grant_idempotency_receipts",
  ).first<{ key_hash: string }>();

  const singleEntryPlan = { ...plan(), manifests: [plan().manifests[0]] };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["notAfter", { notAfter: futureIso(7200) }],
    ["audience", { audience: "https://other-ingest.96bulls.example" }],
    ["apiKeyId", { apiKeyId: otherKey.id }],
    ["plan entries", { plan: singleEntryPlan }],
    ["plan exported_at", { plan: { ...plan(), exported_at: "2026-10-30T00:00:01.000Z" } }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      await expectError(
        await postGrant(app, { ...body, ...override }, grantHeaders(key)),
        409,
        "idempotency_key_conflict",
      );
    });
  }

  const conflicts = await deniedCreateAudits(app, "idempotency_key_conflict");
  assert.equal(conflicts.length, cases.length);
  for (const metadata of conflicts) {
    assert.equal(metadata.idempotencyKeyHash, receipt?.key_hash);
  }
  assert.deepEqual(await grantCounts(app), {
    grants: 1,
    receipts: 1,
    createdAudits: 1,
  });
  // The original grant is untouched and still recoverable.
  const retry = await postGrant(app, body, grantHeaders(key));
  assert.equal(retry.status, 201);
  assert.deepEqual((await retry.json()) as GrantResponse, original);
});

test("idempotency: a key from another org or another caller is treated as absent", async () => {
  const { app, migrationKey } = await createHarness();
  const otherOrgKey = await seedApiKey(app, { orgId: "org_other" });
  const key = newIdempotencyKey();
  const body = grantBody(migrationKey.id);
  const original = await assertJsonResponse<GrantResponse>(
    await postGrant(app, body, grantHeaders(key)),
    201,
  );

  // Another caller in the same org, same key and same request: a fresh grant.
  const otherCallerClaims = {
    sub: "user_admin_2",
    sponsorId: "user_admin_2",
    sponsorChain: ["user_admin_2"],
  };
  const otherCaller = await postGrant(app, body, grantHeaders(key, otherCallerClaims));
  assert.equal(otherCaller.status, 201);
  assert.equal(otherCaller.headers.get("Idempotent-Replayed"), null);
  const otherCallerGrant = (await otherCaller.json()) as GrantResponse;
  assert.notEqual(otherCallerGrant.grantId, original.grantId);
  assert.equal(otherCallerGrant.createdBy, "user_admin_2");

  // Another caller, same key, different request: not a conflict either, so the
  // response cannot reveal that the key exists for someone else.
  const otherCallerDifferent = await postGrant(
    app,
    { ...body, notAfter: futureIso(7200) },
    grantHeaders(key, { ...otherCallerClaims, sub: "user_admin_3" }),
  );
  assert.equal(otherCallerDifferent.status, 201);
  assert.equal(otherCallerDifferent.headers.get("Idempotent-Replayed"), null);

  // Another org, same key: its answer is exactly what an unused key gets.
  const otherOrgPlan = {
    ...plan({ orgId: "org_other", aliceUser: "user_other_org" }),
    manifests: [plan({ orgId: "org_other", aliceUser: "user_other_org" }).manifests[0]],
  };
  const otherOrgClaims = { org: "org_other" };
  const otherOrgBody = grantBody(otherOrgKey.id, { plan: otherOrgPlan });
  const otherOrg = await postGrant(app, otherOrgBody, grantHeaders(key, otherOrgClaims));
  assert.equal(otherOrg.status, 201);
  assert.equal(otherOrg.headers.get("Idempotent-Replayed"), null);
  const otherOrgGrant = (await otherOrg.json()) as GrantResponse;
  assert.equal(otherOrgGrant.orgId, "org_other");
  assert.notEqual(otherOrgGrant.grantId, original.grantId);

  // Replaying the first org's request body from the other org is judged on
  // its own merits (cross-org plan), never as a hit on the first org's key.
  const crossOrgReplay = await postGrant(app, body, grantHeaders(key, otherOrgClaims));
  const freshKeyCrossOrg = await postGrant(app, body, grantHeaders(newIdempotencyKey(), otherOrgClaims));
  assert.equal(crossOrgReplay.status, freshKeyCrossOrg.status);
  assert.deepEqual(await crossOrgReplay.json(), await freshKeyCrossOrg.json());

  assert.deepEqual(await deniedCreateAudits(app, "idempotency_key_conflict"), []);

  // The receipts are disjoint and the storage lookup is caller- and org-bound.
  const receipts = await app.storage.DB.prepare(
    "SELECT org_id, key_hash, caller_id FROM migration_grant_idempotency_receipts ORDER BY created_at",
  ).all<{ org_id: string; key_hash: string; caller_id: string }>();
  const rows = receipts.results ?? [];
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.key_hash)).size, 4);
  const first = rows.find((row) => row.caller_id === "user_admin" && row.org_id === ORG)!;
  assert.equal(
    await app.storage.migrationGrants!.findByIdempotencyKey({
      orgId: "org_other",
      keyHash: first.key_hash,
      callerId: "user_admin",
    }),
    null,
  );
  assert.equal(
    await app.storage.migrationGrants!.findByIdempotencyKey({
      orgId: ORG,
      keyHash: first.key_hash,
      callerId: "user_admin_2",
    }),
    null,
  );
  // The original caller's grant is still the one its key returns.
  const retry = await postGrant(app, body, grantHeaders(key));
  assert.deepEqual((await retry.json()) as GrantResponse, original);
});

test("idempotency: a failure mid-transaction leaves no receipt, grant or audit", async (t) => {
  const failures: Array<[string, string]> = [
    [
      "receipt insert",
      `CREATE TRIGGER fail_fixture BEFORE INSERT ON migration_grant_idempotency_receipts
       BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`,
    ],
    [
      "audit insert",
      `CREATE TRIGGER fail_fixture BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'migration_grant.created' AND NEW.result = 'allowed'
       BEGIN SELECT RAISE(ABORT, 'fixture create audit failure'); END`,
    ],
  ];
  for (const [name, trigger] of failures) {
    await t.test(name, async () => {
      const { app, migrationKey } = await createHarness();
      const key = newIdempotencyKey();
      const body = grantBody(migrationKey.id);
      await app.storage.DB.prepare(trigger).run();
      const failed = await silenceConsoleError(() =>
        postGrant(app, body, grantHeaders(key)),
      );
      assert.equal(failed.status, 500);
      assert.deepEqual(await grantCounts(app), {
        grants: 0,
        receipts: 0,
        createdAudits: 0,
      });

      // The key was never consumed: the retry creates the grant normally.
      await app.storage.DB.prepare("DROP TRIGGER fail_fixture").run();
      const retry = await postGrant(app, body, grantHeaders(key));
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get("Idempotent-Replayed"), null);
      assert.deepEqual(await grantCounts(app), {
        grants: 1,
        receipts: 1,
        createdAudits: 1,
      });
    });
  }
});

test("idempotency: recovery works while disabled, expired or revoked without changing the grant", async (t) => {
  await t.test("issuance disabled", async () => {
    const { app, migrationKey } = await createHarness();
    const key = newIdempotencyKey();
    const body = grantBody(migrationKey.id);
    const original = await assertJsonResponse<GrantResponse>(
      await postGrant(app, body, grantHeaders(key)),
      201,
    );
    for (const flag of [undefined, "false"]) {
      const disabledApp = createTestApp(
        { RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS: flag },
        { storage: app.storage },
      );
      const recovered = await postGrant(disabledApp, body, grantHeaders(key));
      assert.equal(recovered.status, 201);
      assert.equal(recovered.headers.get("Idempotent-Replayed"), "true");
      assert.deepEqual((await recovered.json()) as GrantResponse, original);

      // Everything that is not a recovery stays the disabled refusal.
      await expectError(
        await postGrant(disabledApp, body, grantHeaders()),
        403,
        "migration_assertions_disabled",
      );
      await expectError(
        await postGrant(disabledApp, body, adminHeaders()),
        403,
        "migration_assertions_disabled",
      );
      await expectError(
        await postGrant(disabledApp, { ...body, plan: {} }, grantHeaders(key)),
        403,
        "migration_assertions_disabled",
      );
      // A changed request under the same key is still a conflict.
      await expectError(
        await postGrant(disabledApp, { ...body, notAfter: futureIso(7200) }, grantHeaders(key)),
        409,
        "idempotency_key_conflict",
      );
      // Minting stays disabled: recovery does not re-enable issuance.
      await expectError(
        await mint(disabledApp, migrationKey.key, mintBody(original.grantId)),
        403,
        "migration_assertions_disabled",
      );
    }
    assert.deepEqual(await grantCounts(app), {
      grants: 1,
      receipts: 1,
      createdAudits: 1,
    });
  });

  await t.test("expired", async () => {
    const { app, migrationKey } = await createHarness();
    const key = newIdempotencyKey();
    const body = grantBody(migrationKey.id, { notAfter: futureIso(60) });
    const original = await assertJsonResponse<GrantResponse>(
      await postGrant(app, body, grantHeaders(key)),
      201,
    );
    const realNow = Date.now;
    const later = realNow() + 2 * 3600 * 1000;
    Date.now = () => later;
    try {
      // The request's own notAfter is now in the past.
      assert.ok(Date.parse(body.notAfter) < Date.now());
      const recovered = await postGrant(app, body, grantHeaders(key));
      assert.equal(recovered.status, 201);
      assert.equal(recovered.headers.get("Idempotent-Replayed"), "true");
      assert.deepEqual((await recovered.json()) as GrantResponse, original);
      // A fresh create with that request is refused, so recovery is the only
      // path and it does not recreate or extend anything.
      await expectError(
        await postGrant(app, body, grantHeaders()),
        400,
        "invalid_not_after",
      );
      await expectError(
        await mint(app, migrationKey.key, mintBody(original.grantId)),
        403,
        "migration_grant_expired",
      );
    } finally {
      Date.now = realNow;
    }
    const stored = await app.storage.migrationGrants!.get(original.grantId);
    assert.equal(stored?.notAfter, original.notAfter);
    assert.deepEqual(await grantCounts(app), {
      grants: 1,
      receipts: 1,
      createdAudits: 1,
    });
  });

  await t.test("revoked", async () => {
    const { app, migrationKey } = await createHarness();
    const key = newIdempotencyKey();
    const body = grantBody(migrationKey.id);
    const original = await assertJsonResponse<GrantResponse>(
      await postGrant(app, body, grantHeaders(key)),
      201,
    );
    const revoked = await assertJsonResponse<GrantResponse>(
      await request(app, "POST", `/v1/migration-grants/${original.grantId}/revoke`, undefined, adminHeaders()),
      200,
    );
    assert.ok(revoked.revokedAt);
    const recovered = await postGrant(app, body, grantHeaders(key));
    assert.equal(recovered.status, 201);
    assert.equal(recovered.headers.get("Idempotent-Replayed"), "true");
    const recoveredGrant = (await recovered.json()) as GrantResponse;
    assert.deepEqual(recoveredGrant, revoked, "revocation state is returned, not cleared");
    assert.equal(recoveredGrant.grantId, original.grantId);
    await expectError(
      await mint(app, migrationKey.key, mintBody(original.grantId)),
      403,
      "migration_grant_revoked",
    );
    assert.deepEqual(await grantCounts(app), {
      grants: 1,
      receipts: 1,
      createdAudits: 1,
    });
  });
});

test("idempotency: the key is required, high entropy, and refusals are audited", async (t) => {
  const { app, migrationKey } = await createHarness();
  const body = grantBody(migrationKey.id);
  const cases: Array<[string, Record<string, string>, string]> = [
    ["missing", adminHeaders() as Record<string, string>, "idempotency_key_required"],
    ["too short", grantHeaders("abcdefghijklmnopqrstuvwxyz01234"), "invalid_idempotency_key"],
    ["too long", grantHeaders(`${newIdempotencyKey()}${"x".repeat(100)}`), "invalid_idempotency_key"],
    ["low entropy", grantHeaders("a".repeat(40)), "invalid_idempotency_key"],
    ["bad characters", grantHeaders(`${newIdempotencyKey()}!`), "invalid_idempotency_key"],
  ];
  for (const [name, headers, code] of cases) {
    await t.test(name, async () => {
      const response = await postGrant(app, body, headers);
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.equal((JSON.parse(text) as ErrorBody).code, code);
      const raw = headers[IDEMPOTENCY_HEADER];
      if (raw) {
        assert.equal(text.includes(raw), false, "refusal must not echo the key");
      }
      assert.equal((await deniedCreateAudits(app, code)).length > 0, true);
    });
  }
  // A UUIDv4 is accepted.
  assert.equal(
    (await postGrant(app, body, grantHeaders(crypto.randomUUID()))).status,
    201,
  );
  assert.deepEqual(await grantCounts(app), {
    grants: 1,
    receipts: 1,
    createdAudits: 1,
  });
});

test("idempotency: the raw key never appears in the database, audit, responses or logs", async () => {
  const { app, migrationKey } = await createHarness();
  const key = newIdempotencyKey();
  const body = grantBody(migrationKey.id);
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      captured.push(
        args
          .map((arg) =>
            arg instanceof Error
              ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`
              : typeof arg === "string"
                ? arg
                : JSON.stringify(arg, (_k, v) =>
                    v instanceof Error ? `${v.message}\n${v.stack ?? ""}` : v,
                  ),
          )
          .join(" "),
      );
    };
  }
  const responseTexts: string[] = [];
  const record = async (response: Promise<Response>) => {
    const resolved = await response;
    responseTexts.push(
      JSON.stringify([...resolved.headers.entries()]),
      await resolved.text(),
    );
    return resolved;
  };
  try {
    // A failed create (logged 500), the real create, a replay, a conflict,
    // a disabled recovery and a disabled miss.
    await app.storage.DB.prepare(`
      CREATE TRIGGER fail_fixture BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'migration_grant.created' AND NEW.result = 'allowed'
      BEGIN SELECT RAISE(ABORT, 'fixture create audit failure'); END
    `).run();
    assert.equal((await record(postGrant(app, body, grantHeaders(key)))).status, 500);
    await app.storage.DB.prepare("DROP TRIGGER fail_fixture").run();
    assert.equal((await record(postGrant(app, body, grantHeaders(key)))).status, 201);
    assert.equal((await record(postGrant(app, body, grantHeaders(key)))).status, 201);
    assert.equal(
      (await record(postGrant(app, { ...body, notAfter: futureIso(7200) }, grantHeaders(key)))).status,
      409,
    );
    const disabledApp = createTestApp(
      { RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS: "false" },
      { storage: app.storage },
    );
    assert.equal((await record(postGrant(disabledApp, body, grantHeaders(key)))).status, 201);
    assert.equal(
      (await record(postGrant(disabledApp, { ...body, plan: {} }, grantHeaders(key)))).status,
      403,
    );
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
  }

  assert.ok(captured.length > 0, "the failed create was logged");
  for (const line of captured) {
    assert.equal(line.includes(key), false, "raw key leaked into a log line");
  }
  for (const text of responseTexts) {
    assert.equal(text.includes(key), false, "raw key leaked into a response");
  }

  const tables = await app.storage.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all<{ name: string }>();
  let rowsScanned = 0;
  for (const { name } of tables.results ?? []) {
    const rows = await app.storage.DB.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      rowsScanned += 1;
      assert.equal(JSON.stringify(row).includes(key), false, `raw key stored in ${name}`);
    }
  }
  assert.ok(rowsScanned > 0);
  const auditEntries = await app.storage.audit.query({ orgId: ORG, limit: 200 });
  assert.ok(auditEntries.entries.length > 0);
  assert.equal(JSON.stringify(auditEntries).includes(key), false);
  // The stored hash is not a bare SHA-256 of the key either.
  const receipt = await app.storage.DB.prepare(
    "SELECT key_hash FROM migration_grant_idempotency_receipts",
  ).first<{ key_hash: string }>();
  assert.notEqual(receipt?.key_hash, crypto.createHash("sha256").update(key).digest("hex"));
});

test("idempotency: the fingerprint plan strips every generated grant_id, backfills included", () => {
  const derived = deriveMigrationGrantPlan({
    grantId: "mgr_11111111111111111111111111111111",
    orgId: ORG,
    plan: plan(),
  });
  // v1: identical to the construction #112 shipped with.
  const { grant_id: _g, ...rest } = derived.plan;
  assert.deepEqual(migrationGrantFingerprintPlan(derived.plan), {
    ...rest,
    manifests: rest.manifests.map(({ grant_id: _e, ...entry }) => entry),
  });
  assert.equal("backfills" in migrationGrantFingerprintPlan(derived.plan), false);

  // v2 shape (relayauth #117): backfill entries lose grant_id too, so two
  // derivations under different generated ids fingerprint identically.
  const v2 = (grantId: string) => ({
    v: 2,
    grant_id: grantId,
    exported_at: "2026-10-30T00:00:00.000Z",
    manifests: [{ key: "a", grant_id: grantId }],
    backfills: [{ v: 2, kind: "backfill", key: "b", grant_id: grantId, raw_bytes: 1 }],
  });
  const first = migrationGrantFingerprintPlan(v2("mgr_11111111111111111111111111111111"));
  const second = migrationGrantFingerprintPlan(v2("mgr_22222222222222222222222222222222"));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes("grant_id"), false);
  assert.deepEqual(first, {
    v: 2,
    exported_at: "2026-10-30T00:00:00.000Z",
    manifests: [{ key: "a" }],
    backfills: [{ v: 2, kind: "backfill", key: "b", raw_bytes: 1 }],
  });
});
