import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { RelayAuthTokenClaims } from "@relayauth/types";

import { extractPrefix, generateApiKey, hashApiKey } from "../lib/api-keys.js";
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

type ErrorBody = {
  error?: string;
  code?: string;
  userId?: string;
};

type GrantResponse = {
  grantId: string;
  orgId: string;
  apiKeyId: string;
  planDigest: string;
  audience: string;
  allowedUserIds: string[];
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

type AuditRow = {
  action: string;
  identity_id: string;
  org_id: string;
  workspace_id: string | null;
  resource: string;
  result: string;
  metadata_json: string | null;
};

const ORG = "org_migration";
const OTHER_ORG = "org_migration_other";
const MIGRATION_SCOPE = "relayauth:assertion:create:migration";
const RELAYHISTORY_SCOPE = "relayauth:assertion:create:relayhistory";
const MANAGE_SCOPE = "relayauth:api-key:manage:*";
const PLAN_DIGEST = "a".repeat(64);
const AUDIENCE = "https://ingest.96bulls.example";
const NONCE = "nonce_0123456789abcdef";

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
      sub: "user_migration_admin",
      org: ORG,
      wks: "ws_migration_admin",
      sponsorId: "user_migration_admin",
      sponsorChain: ["user_migration_admin"],
      scopes: [MANAGE_SCOPE],
      ...overrides,
    })}`,
  };
}

async function seedApiKey(
  app: TestApp,
  {
    orgId = ORG,
    scopes = [MIGRATION_SCOPE],
    kind,
  }: { orgId?: string; scopes?: string[]; kind?: ApiKeyKind } = {},
): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const stored = await app.storage.apiKeys.create({
    orgId,
    name: "migration-export",
    prefix: extractPrefix(key),
    keyHash: hashApiKey(key),
    scopes,
    ...(kind ? { kind, workspaceId: "ws_migration" } : {}),
  });
  return { id: stored.id, key };
}

async function seedUsers(app: TestApp): Promise<void> {
  await seedStoredIdentity(app, createIdentity("user_alice"));
  await seedStoredIdentity(app, createIdentity("user_bob"));
  await seedStoredIdentity(app, createIdentity("user_carol"));
  await seedStoredIdentity(
    app,
    createIdentity("user_other_org", { orgId: OTHER_ORG }),
  );
  await seedStoredIdentity(
    app,
    createIdentity("agent_not_human", { type: "agent" }),
  );
  await seedStoredIdentity(
    app,
    createIdentity("user_retired", { status: "retired" }),
  );
}

async function createHarness(bindings: Parameters<typeof createTestApp>[0] = {}) {
  const app = createTestApp(bindings);
  await seedUsers(app);
  const migrationKey = await seedApiKey(app);
  return { app, migrationKey };
}

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function grantBody(
  apiKeyId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiKeyId,
    planDigest: PLAN_DIGEST,
    audience: AUDIENCE,
    allowedUserIds: ["user_alice", "user_bob"],
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

async function postGrant(
  app: TestApp,
  body: Record<string, unknown>,
  headers: HeadersInit = adminHeaders(),
): Promise<Response> {
  return request(app, "POST", "/v1/migration-grants", body, headers);
}

async function createGrant(
  app: TestApp,
  apiKeyId: string,
  overrides: Record<string, unknown> = {},
): Promise<GrantResponse> {
  return assertJsonResponse<GrantResponse>(
    await postGrant(app, grantBody(apiKeyId, overrides)),
    201,
  );
}

async function mint(
  app: TestApp,
  key: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return request(app, "POST", "/v1/tokens/migration-assertion", body, {
    "x-api-key": key,
  });
}

function mintBody(
  grantId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    grantId,
    sourceUserId: "user_alice",
    workspaceId: "ws_alice_history",
    nonce: NONCE,
    ...overrides,
  };
}

function decodeClaims(token: string): RelayAuthTokenClaims {
  const [, payload] = token.split(".");
  return JSON.parse(
    Buffer.from(payload ?? "", "base64url").toString("utf8"),
  ) as RelayAuthTokenClaims;
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

async function auditRows(
  app: TestApp,
  resource: string,
  result: string,
): Promise<AuditRow[]> {
  const rows = await app.storage.DB.prepare(
    `
      SELECT action, identity_id, org_id, workspace_id, resource, result, metadata_json
      FROM audit_logs
      WHERE resource = ? AND result = ?
      ORDER BY timestamp ASC
    `,
  )
    .bind(resource, result)
    .all<AuditRow>();
  return rows.results;
}

async function countRows(app: TestApp, table: string): Promise<number> {
  const row = await app.storage.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function expectGrantRefusal(
  app: TestApp,
  body: Record<string, unknown>,
  status: number,
  code: string,
  headers?: HeadersInit,
): Promise<ErrorBody> {
  const before = await auditRows(app, "migration-grant", "denied");
  const response = await postGrant(app, body, headers);
  const errorBody = await assertJsonResponse<ErrorBody>(response, status, (b) => {
    assert.equal(b.code, code);
  });
  assert.equal(await countRows(app, "migration_grants"), 0);
  const after = await auditRows(app, "migration-grant", "denied");
  assert.equal(after.length, before.length + 1, `refusal ${code} must be audited`);
  const audit = after[after.length - 1]!;
  assert.equal(audit.action, "migration_grant.created");
  assert.equal(JSON.parse(audit.metadata_json ?? "{}").reason, code);
  return errorBody;
}

async function expectMintRefusal(
  app: TestApp,
  key: string,
  body: Record<string, unknown>,
  status: number,
  code: string,
): Promise<void> {
  const before = await auditRows(app, "migration-assertion", "denied");
  const response = await mint(app, key, body);
  await assertJsonResponse<ErrorBody>(response, status, (b) => {
    assert.equal(b.code, code);
  });
  assert.equal(
    (await auditRows(app, "migration-assertion", "allowed")).length,
    0,
    "a refused mint must not issue an assertion",
  );
  const after = await auditRows(app, "migration-assertion", "denied");
  assert.equal(after.length, before.length + 1, `refusal ${code} must be audited`);
  const audit = after[after.length - 1]!;
  assert.equal(audit.action, "token.issued");
  assert.equal(JSON.parse(audit.metadata_json ?? "{}").reason, code);
}

test("POST /v1/migration-grants", async (t) => {
  await t.test("creates a grant bound to a dedicated migration key", async () => {
    const { app, migrationKey } = await createHarness();
    const notAfter = futureIso(6 * 24 * 3600);

    const grant = await createGrant(app, migrationKey.id, {
      allowedUserIds: ["user_alice", "user_bob", "user_alice"],
      notAfter,
    });

    assert.match(grant.grantId, /^mgr_[0-9a-f]{32}$/);
    assert.equal(grant.orgId, ORG);
    assert.equal(grant.apiKeyId, migrationKey.id);
    assert.equal(grant.planDigest, PLAN_DIGEST);
    assert.equal(grant.audience, AUDIENCE);
    assert.deepEqual(grant.allowedUserIds, ["user_alice", "user_bob"]);
    assert.equal(grant.notAfter, notAfter);
    assert.equal(grant.createdBy, "user_migration_admin");
    assert.equal(grant.revokedAt, null);

    const stored = await app.storage.migrationGrants!.get(grant.grantId);
    assert.deepEqual(stored?.allowedUserIds, ["user_alice", "user_bob"]);

    const [audit] = await auditRows(app, "migration-grant", "allowed");
    assert.equal(audit?.action, "migration_grant.created");
    assert.equal(audit?.identity_id, "user_migration_admin");
    assert.equal(audit?.org_id, ORG);
    assert.deepEqual(JSON.parse(audit?.metadata_json ?? "{}"), {
      grantId: grant.grantId,
      apiKeyId: migrationKey.id,
      planDigest: PLAN_DIGEST,
      audience: AUDIENCE,
      allowedUserCount: "2",
      notAfter,
    });
  });

  await t.test("canonicalises the audience origin", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id, {
      audience: "https://Ingest.96Bulls.Example:443/",
    });
    assert.equal(grant.audience, AUDIENCE);
  });

  await t.test("accepts an admin api key with the manage scope", async () => {
    const { app, migrationKey } = await createHarness();
    const adminKey = await seedApiKey(app, { scopes: [MANAGE_SCOPE] });
    const response = await postGrant(app, grantBody(migrationKey.id), {
      "x-api-key": adminKey.key,
    });
    const grant = await assertJsonResponse<GrantResponse>(response, 201);
    assert.equal(grant.createdBy, `api_key:${adminKey.id}`);
  });

  await t.test("refuses a caller without the api-key manage scope", async () => {
    const { app, migrationKey } = await createHarness();
    await expectGrantRefusal(
      app,
      grantBody(migrationKey.id),
      403,
      "insufficient_scope",
      adminHeaders({ scopes: [MIGRATION_SCOPE, "relayauth:api-key:read:*"] }),
    );
  });

  await t.test("refuses the migration key itself as the grant creator", async () => {
    const { app, migrationKey } = await createHarness();
    await expectGrantRefusal(
      app,
      grantBody(migrationKey.id),
      403,
      "insufficient_scope",
      { "x-api-key": migrationKey.key },
    );
  });

  await t.test("refuses an unauthenticated caller without auditing", async () => {
    const { app, migrationKey } = await createHarness();
    const response = await postGrant(app, grantBody(migrationKey.id), {});
    assert.equal(response.status, 401);
    assert.equal((await auditRows(app, "migration-grant", "denied")).length, 0);
  });

  await t.test("refuses an api key of another org", async () => {
    const { app } = await createHarness();
    const otherKey = await seedApiKey(app, { orgId: OTHER_ORG });
    await expectGrantRefusal(app, grantBody(otherKey.id), 404, "api_key_not_found");
  });

  await t.test("refuses an unknown api key", async () => {
    const { app } = await createHarness();
    await expectGrantRefusal(app, grantBody("ak_missing"), 404, "api_key_not_found");
  });

  await t.test("refuses a key without the migration scope", async () => {
    const { app } = await createHarness();
    const key = await seedApiKey(app, { scopes: [RELAYHISTORY_SCOPE] });
    await expectGrantRefusal(app, grantBody(key.id), 400, "migration_scope_missing");
  });

  await t.test("refuses a wildcard key that only implies the migration scope", async () => {
    const { app } = await createHarness();
    const key = await seedApiKey(app, { scopes: ["relayauth:assertion:create:*"] });
    await expectGrantRefusal(app, grantBody(key.id), 400, "migration_scope_missing");
  });

  await t.test("refuses a key that carries scopes besides the migration scope", async () => {
    const { app } = await createHarness();
    const key = await seedApiKey(app, { scopes: [MIGRATION_SCOPE, MANAGE_SCOPE] });
    await expectGrantRefusal(app, grantBody(key.id), 400, "migration_key_not_dedicated");
  });

  await t.test("refuses a workspace token", async () => {
    const { app } = await createHarness();
    const key = await seedApiKey(app, { kind: "workspace_token" });
    await expectGrantRefusal(app, grantBody(key.id), 400, "migration_key_not_dedicated");
  });

  await t.test("refuses a revoked key", async () => {
    const { app, migrationKey } = await createHarness();
    await app.storage.apiKeys.revoke(migrationKey.id, new Date().toISOString());
    await expectGrantRefusal(app, grantBody(migrationKey.id), 409, "api_key_revoked");
  });

  await t.test("refuses a notAfter in the past, too far out, or malformed", async () => {
    const { app, migrationKey } = await createHarness();
    for (const notAfter of [
      futureIso(-60),
      futureIso(7 * 24 * 3600 + 120),
      "2026-13-01T00:00:00Z",
      "tomorrow",
      1_900_000_000,
      undefined,
    ]) {
      await expectGrantRefusal(
        app,
        grantBody(migrationKey.id, { notAfter }),
        400,
        "invalid_not_after",
      );
    }
  });

  await t.test("refuses an audience that is not an exact https origin", async () => {
    const { app, migrationKey } = await createHarness();
    for (const audience of [
      undefined,
      "",
      "ingest.96bulls.example",
      "http://ingest.96bulls.example",
      "http://localhost:8080",
      "http://ingest.svc:8080",
      "https://ingest.96bulls.example/v1",
      "https://ingest.96bulls.example?x=1",
      "https://user:pass@ingest.96bulls.example",
      "https://ingest.96bulls.example.",
      ["https://ingest.96bulls.example"],
    ]) {
      await expectGrantRefusal(
        app,
        grantBody(migrationKey.id, { audience }),
        400,
        "invalid_audience",
      );
    }
  });

  await t.test("accepts private http only behind the self-host flag", async () => {
    const { app, migrationKey } = await createHarness({
      RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN: "true",
    });
    const grant = await createGrant(app, migrationKey.id, {
      audience: "http://ingest.ingest.svc:8080",
    });
    assert.equal(grant.audience, "http://ingest.ingest.svc:8080");

    // The flag never admits plain http to a public name.
    const response = await postGrant(
      app,
      grantBody(migrationKey.id, { audience: "http://ingest.96bulls.example" }),
    );
    await assertJsonResponse<ErrorBody>(response, 400, (b) => {
      assert.equal(b.code, "invalid_audience");
    });
  });

  await t.test("refuses a plan digest that is not 64 lowercase hex", async () => {
    const { app, migrationKey } = await createHarness();
    for (const planDigest of [
      undefined,
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      ` ${"a".repeat(64)}`,
    ]) {
      await expectGrantRefusal(
        app,
        grantBody(migrationKey.id, { planDigest }),
        400,
        "invalid_plan_digest",
      );
    }
  });

  await t.test("refuses an empty, oversized or malformed allowed-user list", async () => {
    const { app, migrationKey } = await createHarness();
    for (const allowedUserIds of [
      undefined,
      [],
      "user_alice",
      ["user alice"],
      [42],
      Array.from({ length: 1001 }, (_, index) => `user_${index}`),
    ]) {
      await expectGrantRefusal(
        app,
        grantBody(migrationKey.id, { allowedUserIds }),
        400,
        "invalid_allowed_users",
      );
    }
  });

  await t.test("refuses any allowed user that is not an active human of the org", async () => {
    const { app, migrationKey } = await createHarness();
    for (const [userId, code] of [
      ["user_unknown", "source_user_not_found"],
      ["user_other_org", "source_user_org_mismatch"],
      ["agent_not_human", "source_user_not_human"],
      ["user_retired", "source_user_inactive"],
    ] as const) {
      const body = await expectGrantRefusal(
        app,
        grantBody(migrationKey.id, { allowedUserIds: ["user_alice", userId] }),
        403,
        code,
      );
      assert.equal(body.userId, userId);
    }
  });
});

test("POST /v1/migration-grants/:grantId/revoke", async (t) => {
  await t.test("revokes a grant of the caller's org once, with audit", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);

    const response = await request(
      app,
      "POST",
      `/v1/migration-grants/${grant.grantId}/revoke`,
      undefined,
      adminHeaders(),
    );
    const revoked = await assertJsonResponse<GrantResponse>(response, 200);
    assert.equal(revoked.grantId, grant.grantId);
    assert.ok(revoked.revokedAt);
    assert.ok((await app.storage.migrationGrants!.get(grant.grantId))?.revokedAt);

    const allowed = await auditRows(app, "migration-grant", "allowed");
    assert.deepEqual(
      allowed.map((row) => row.action),
      ["migration_grant.created", "migration_grant.revoked"],
    );

    const again = await request(
      app,
      "POST",
      `/v1/migration-grants/${grant.grantId}/revoke`,
      undefined,
      adminHeaders(),
    );
    await assertJsonResponse<ErrorBody>(again, 409, (b) => {
      assert.equal(b.code, "migration_grant_revoked");
    });
    const [denied] = await auditRows(app, "migration-grant", "denied");
    assert.equal(denied?.action, "migration_grant.revoked");
  });

  await t.test("refuses another org's grant and a caller without the scope", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);

    const otherOrg = await request(
      app,
      "POST",
      `/v1/migration-grants/${grant.grantId}/revoke`,
      undefined,
      adminHeaders({ org: OTHER_ORG }),
    );
    await assertJsonResponse<ErrorBody>(otherOrg, 404, (b) => {
      assert.equal(b.code, "migration_grant_not_found");
    });

    const noScope = await request(
      app,
      "POST",
      `/v1/migration-grants/${grant.grantId}/revoke`,
      undefined,
      adminHeaders({ scopes: ["relayauth:api-key:read:*"] }),
    );
    await assertJsonResponse<ErrorBody>(noScope, 403, (b) => {
      assert.equal(b.code, "insufficient_scope");
    });

    assert.equal((await app.storage.migrationGrants!.get(grant.grantId))?.revokedAt, undefined);
    const denied = await auditRows(app, "migration-grant", "denied");
    assert.deepEqual(
      denied.map((row) => [row.org_id, JSON.parse(row.metadata_json ?? "{}").reason]),
      [
        [OTHER_ORG, "migration_grant_not_found"],
        [ORG, "insufficient_scope"],
      ],
    );
  });
});

test("POST /v1/tokens/migration-assertion", async (t) => {
  await t.test("mints a single-user, origin-bound, access-only assertion", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);

    const response = await mint(app, migrationKey.key, mintBody(grant.grantId));
    const body = await assertJsonResponse<AssertionResponse>(response, 201);
    assert.equal(body.tokenType, "Bearer");
    assert.equal("refreshToken" in body, false);
    assert.equal(verifySignature(body.accessToken), true);

    const claims = decodeClaims(body.accessToken);
    assert.equal(claims.sub, "agent_relayhistory_migration");
    assert.equal(claims.org, ORG);
    assert.equal(claims.wks, "ws_alice_history");
    assert.equal(claims.sponsorId, "user_alice");
    assert.deepEqual(claims.sponsorChain, ["user_alice", "agent_relayhistory_migration"]);
    assert.deepEqual(claims.scopes, ["rth:sync"]);
    assert.deepEqual(claims.aud, [AUDIENCE]);
    assert.equal(claims.token_type, "access");
    assert.equal(claims.iss, "https://relayauth.dev");
    assert.equal(claims.exp - claims.iat, 60);
    assert.equal(body.accessTokenExpiresAt, new Date(claims.exp * 1000).toISOString());
    assert.match(claims.jti, /^tok_[0-9a-f]{32}$/);
    assert.match(claims.sid ?? "", /^sess_[0-9a-f]{32}$/);
    assert.deepEqual(claims.meta, {
      tokenClass: "migration_assertion",
      grantId: grant.grantId,
      planDigest: PLAN_DIGEST,
      nonce: NONCE,
      sourceUserId: "user_alice",
      actorId: `api_key:${migrationKey.id}`,
      actorOrgId: ORG,
      workspaceId: "ws_alice_history",
    });

    assert.equal(await countRows(app, "tokens"), 1);
    const [audit] = await auditRows(app, "migration-assertion", "allowed");
    assert.equal(audit?.action, "token.issued");
    assert.equal(audit?.identity_id, `api_key:${migrationKey.id}`);
    assert.equal(audit?.org_id, ORG);
    assert.equal(audit?.workspace_id, "ws_alice_history");
    assert.deepEqual(JSON.parse(audit?.metadata_json ?? "{}"), {
      tokenId: claims.jti,
      actorOrgId: ORG,
      grantId: grant.grantId,
      planDigest: PLAN_DIGEST,
      sourceUserId: "user_alice",
      nonce: NONCE,
      grantedScopes: JSON.stringify(["rth:sync"]),
    });
  });

  await t.test("honours a shorter expiresIn and caps exp at the grant deadline", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);

    const short = await assertJsonResponse<AssertionResponse>(
      await mint(app, migrationKey.key, mintBody(grant.grantId, { expiresIn: 15 })),
      201,
    );
    const shortClaims = decodeClaims(short.accessToken);
    assert.equal(shortClaims.exp - shortClaims.iat, 15);

    const notAfter = futureIso(10);
    await app.storage.DB.prepare(
      "UPDATE migration_grants SET not_after = ? WHERE grant_id = ?",
    ).bind(notAfter, grant.grantId).run();
    const capped = await assertJsonResponse<AssertionResponse>(
      await mint(app, migrationKey.key, mintBody(grant.grantId)),
      201,
    );
    const cappedClaims = decodeClaims(capped.accessToken);
    assert.ok(cappedClaims.exp <= Math.floor(Date.parse(notAfter) / 1000));
  });

  await t.test("refuses expiresIn outside 1..60", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    for (const expiresIn of [61, 3600, 0, -1, 1.5, "30"]) {
      await expectMintRefusal(
        app,
        migrationKey.key,
        mintBody(grant.grantId, { expiresIn }),
        400,
        "invalid_expires_in",
      );
    }
  });

  await t.test("refuses a malformed nonce", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    for (const nonce of [
      undefined,
      "short",
      "a".repeat(15),
      "a".repeat(129),
      "nonce with spaces!!",
      "nonce/0123456789abcdef",
      12345678901234567890,
    ]) {
      await expectMintRefusal(
        app,
        migrationKey.key,
        mintBody(grant.grantId, { nonce }),
        400,
        "invalid_nonce",
      );
    }
    const boundary = await mint(
      app,
      migrationKey.key,
      mintBody(grant.grantId, { nonce: "a".repeat(128) }),
    );
    assert.equal(boundary.status, 201);
  });

  await t.test("refuses missing grantId, sourceUserId or workspaceId", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { grantId: "" }), 400, "grantId_required");
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: undefined }), 400, "sourceUserId_required");
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { workspaceId: " " }), 400, "workspaceId_required");
  });

  await t.test("refuses a bearer token that carries the migration scope", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    const response = await request(
      app,
      "POST",
      "/v1/tokens/migration-assertion",
      mintBody(grant.grantId),
      adminHeaders({ scopes: [MIGRATION_SCOPE] }),
    );
    await assertJsonResponse<ErrorBody>(response, 403, (b) => {
      assert.equal(b.code, "assertion_key_required");
    });
  });

  await t.test("refuses a workspace token that carries the migration scope", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    const workspaceToken = await seedApiKey(app, { kind: "workspace_token" });
    await expectMintRefusal(
      app,
      workspaceToken.key,
      mintBody(grant.grantId),
      403,
      "assertion_key_required",
    );
  });

  await t.test("refuses a wildcard key that only implies the migration scope", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    const wildcard = await seedApiKey(app, { scopes: ["relayauth:assertion:create:*"] });
    await expectMintRefusal(
      app,
      wildcard.key,
      mintBody(grant.grantId),
      403,
      "assertion_key_required",
    );
  });

  await t.test("refuses a dedicated key the grant does not name", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    const secondKey = await seedApiKey(app);
    await expectMintRefusal(
      app,
      secondKey.key,
      mintBody(grant.grantId),
      403,
      "migration_grant_key_mismatch",
    );
  });

  await t.test("never mints across orgs", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    const otherOrgKey = await seedApiKey(app, { orgId: OTHER_ORG });
    await expectMintRefusal(
      app,
      otherOrgKey.key,
      mintBody(grant.grantId),
      404,
      "migration_grant_not_found",
    );
    const [denied] = await auditRows(app, "migration-assertion", "denied");
    assert.equal(denied?.org_id, OTHER_ORG, "refusals are audited in the caller's org");
  });

  await t.test("refuses an unknown grant", async () => {
    const { app, migrationKey } = await createHarness();
    await expectMintRefusal(
      app,
      migrationKey.key,
      mintBody("mgr_missing"),
      404,
      "migration_grant_not_found",
    );
  });

  await t.test("refuses a revoked grant", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    await request(
      app,
      "POST",
      `/v1/migration-grants/${grant.grantId}/revoke`,
      undefined,
      adminHeaders(),
    );
    await expectMintRefusal(
      app,
      migrationKey.key,
      mintBody(grant.grantId),
      403,
      "migration_grant_revoked",
    );
  });

  await t.test("refuses an expired grant", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    await app.storage.DB.prepare(
      "UPDATE migration_grants SET not_after = ? WHERE grant_id = ?",
    ).bind(futureIso(-1), grant.grantId).run();
    await expectMintRefusal(
      app,
      migrationKey.key,
      mintBody(grant.grantId),
      403,
      "migration_grant_expired",
    );
  });

  await t.test("refuses a revoked api key at authentication", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    await app.storage.apiKeys.revoke(migrationKey.id, new Date().toISOString());
    const response = await mint(app, migrationKey.key, mintBody(grant.grantId));
    await assertJsonResponse<ErrorBody>(response, 401, (b) => {
      assert.equal(b.code, "invalid_api_key");
    });
  });

  await t.test("refuses a source user the grant does not list", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    for (const sourceUserId of ["user_carol", "user_other_org", "agent_not_human", "user_unknown"]) {
      await expectMintRefusal(
        app,
        migrationKey.key,
        mintBody(grant.grantId, { sourceUserId }),
        403,
        "source_user_not_allowed",
      );
    }
  });

  await t.test("re-checks the source user identity on every mint", async () => {
    const { app, migrationKey } = await createHarness();
    await seedStoredIdentity(app, createIdentity("user_dave"));
    await seedStoredIdentity(app, createIdentity("user_erin"));
    await seedStoredIdentity(app, createIdentity("user_frank"));
    const grant = await createGrant(app, migrationKey.id, {
      allowedUserIds: ["user_alice", "user_bob", "user_carol", "user_dave", "user_erin", "user_frank"],
    });

    await app.storage.identities.retire("user_alice", "left");
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: "user_alice" }), 403, "source_user_inactive");

    await app.storage.identities.suspend("user_bob", "investigation");
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: "user_bob" }), 403, "source_user_inactive");

    await app.storage.identities.delete("user_carol");
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: "user_carol" }), 403, "source_user_not_found");

    await app.storage.identities.update("user_dave", { type: "agent" });
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: "user_dave" }), 403, "source_user_not_human");

    // orgId is immutable on update, so model a re-homed id as delete + create.
    await app.storage.identities.delete("user_erin");
    await seedStoredIdentity(app, createIdentity("user_erin", { orgId: OTHER_ORG }));
    await expectMintRefusal(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: "user_erin" }), 403, "source_user_org_mismatch");

    const stillAllowed = await mint(app, migrationKey.key, mintBody(grant.grantId, { sourceUserId: "user_frank" }));
    assert.equal(stillAllowed.status, 201);
  });

  await t.test("the relayhistory assertion scope cannot mint a migration assertion", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    const relayhistoryKey = await seedApiKey(app, { scopes: [RELAYHISTORY_SCOPE] });
    await expectMintRefusal(
      app,
      relayhistoryKey.key,
      mintBody(grant.grantId),
      403,
      "insufficient_scope",
    );
  });

  await t.test("the migration scope cannot mint a relayhistory assertion", async () => {
    const { app, migrationKey } = await createHarness();
    const response = await request(
      app,
      "POST",
      "/v1/tokens/relayhistory-assertion",
      {
        orgId: ORG,
        workspaceId: "ws_alice_history",
        sponsorId: "user_alice",
        scopes: ["rth:sync"],
      },
      { "x-api-key": migrationKey.key },
    );
    await assertJsonResponse<ErrorBody>(response, 403, (b) => {
      assert.equal(b.code, "insufficient_scope");
    });
    assert.equal(await countRows(app, "tokens"), 0);
  });

  await t.test("fails closed without an assertion when its audit cannot commit", async () => {
    const { app, migrationKey } = await createHarness();
    const grant = await createGrant(app, migrationKey.id);
    app.storage.tokens.persistIssuedWithAudit = async () => {
      throw new Error("fault: migration assertion audit");
    };
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const response = await mint(app, migrationKey.key, mintBody(grant.grantId));
      assert.equal(response.status, 500);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(await countRows(app, "tokens"), 0);
  });
});

test("migration grant storage", async (t) => {
  function grantFixture(overrides: Partial<MigrationGrant> = {}): MigrationGrant {
    return {
      grantId: `mgr_${crypto.randomUUID().replace(/-/g, "")}`,
      orgId: ORG,
      apiKeyId: "ak_migration",
      planDigest: PLAN_DIGEST,
      audience: AUDIENCE,
      allowedUserIds: ["user_alice"],
      notAfter: futureIso(3600),
      createdBy: "user_migration_admin",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function auditFixture(grantId: string) {
    return {
      id: crypto.randomUUID(),
      action: "migration_grant.created" as const,
      identityId: "user_migration_admin",
      orgId: ORG,
      resource: "migration-grant",
      result: "allowed" as const,
      metadata: { grantId },
      timestamp: new Date().toISOString(),
    };
  }

  for (const forceMemory of [false, true]) {
    await t.test(`create, get and revoke round-trip (${forceMemory ? "memory" : "sqlite"})`, async () => {
      const storage = createSqliteStorage(":memory:", { forceMemory });
      try {
        const grant = grantFixture();
        await storage.migrationGrants!.createWithAudit({
          grant,
          auditEntry: auditFixture(grant.grantId),
        });
        assert.deepEqual(await storage.migrationGrants!.get(grant.grantId), grant);
        assert.equal(await storage.migrationGrants!.get("mgr_missing"), null);

        await assert.rejects(
          storage.migrationGrants!.createWithAudit({
            grant,
            auditEntry: auditFixture(grant.grantId),
          }),
        );

        await assert.rejects(
          storage.migrationGrants!.revokeWithAudit({
            grantId: grant.grantId,
            orgId: OTHER_ORG,
            revokedAt: new Date().toISOString(),
            auditEntry: auditFixture(grant.grantId),
          }),
          (error: { code?: string }) => error.code === "migration_grant_not_found",
        );

        const revokedAt = new Date().toISOString();
        const revoked = await storage.migrationGrants!.revokeWithAudit({
          grantId: grant.grantId,
          orgId: ORG,
          revokedAt,
          auditEntry: auditFixture(grant.grantId),
        });
        assert.equal(revoked.revokedAt, revokedAt);
        assert.equal((await storage.migrationGrants!.get(grant.grantId))?.revokedAt, revokedAt);

        await assert.rejects(
          storage.migrationGrants!.revokeWithAudit({
            grantId: grant.grantId,
            orgId: ORG,
            revokedAt,
            auditEntry: auditFixture(grant.grantId),
          }),
          (error: { code?: string }) => error.code === "migration_grant_revoked",
        );
      } finally {
        await storage.close();
      }
    });
  }

  await t.test("the schema rejects malformed digests and user lists, atomically with audit", async () => {
    const storage = createSqliteStorage(":memory:");
    try {
      for (const overrides of [
        { planDigest: "A".repeat(64) },
        { planDigest: "a".repeat(63) },
        { allowedUserIds: Array.from({ length: 1001 }, (_, index) => `user_${index}`) },
      ]) {
        const grant = grantFixture(overrides);
        await assert.rejects(
          storage.migrationGrants!.createWithAudit({
            grant,
            auditEntry: auditFixture(grant.grantId),
          }),
        );
      }
      const counts = await storage.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM migration_grants) AS grants, (SELECT COUNT(*) FROM audit_logs) AS audits",
      ).first<{ grants: number; audits: number }>();
      assert.deepEqual({ ...counts }, { grants: 0, audits: 0 });
    } finally {
      await storage.close();
    }
  });
});
