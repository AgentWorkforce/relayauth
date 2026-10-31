import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { hashApiKey } from "../lib/api-keys.js";
import {
  DEDICATED_API_KEY_TYPES,
  ensurePlatformBootstrapApiKey,
  PLATFORM_BOOTSTRAP_API_KEY_NAME,
  PLATFORM_BOOTSTRAP_SCOPE,
} from "../lib/platform-api-keys.js";
import { SESSION_DIRECTORY_SEARCH_MINT_SCOPE } from "../lib/session-directory-issuer.js";
import * as server from "../index.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
  seedPlainApiKey,
} from "./test-helpers.js";

const PLATFORM_ORG = "org_relayauth_platform";
const ROUTE = "/v1/platform/dedicated-api-keys";
const GENERAL_ISSUER = "https://relayauth.dev";
const SEARCH_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ISSUER_ON = {
  RELAYAUTH_ISSUER: GENERAL_ISSUER,
  RELAYAUTH_SESSION_DIRECTORY_ISSUANCE: "true",
  RELAYAUTH_SESSION_DIRECTORY_ISSUER: "https://relayauth.dev/session-directory",
  RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM: SEARCH_KEY,
};

type App = ReturnType<typeof createTestApp>;
const post = (app: App, path: string, body: unknown, headers: HeadersInit) =>
  app.request(createTestRequest("POST", path, body, headers), undefined, app.bindings);
const searchSubject = () =>
  generateTestToken({
    iss: GENERAL_ISSUER,
    aud: ["relayhistory"],
    org: "relay_org_a",
    wks: "relay_ws_a",
    scopes: ["rth:read"],
    sponsorId: "user_a",
  });

async function allKeys(app: App, orgId = PLATFORM_ORG) {
  return app.storage.apiKeys.list(orgId, { limit: 100, includeRevoked: true });
}

async function auditRows(app: App, orgId = PLATFORM_ORG) {
  const result = await app.storage.audit.query({ orgId, limit: 100 });
  return result.entries;
}

async function platformKey(app: App) {
  const result = await ensurePlatformBootstrapApiKey(app.storage, {
    orgId: PLATFORM_ORG,
    operator: "khaliq",
  });
  assert.equal(result.status, "created");
  return result.status === "created" ? result.key : "";
}

test("the platform scope and helper are exported for hosted operators", () => {
  assert.equal(server.PLATFORM_BOOTSTRAP_SCOPE, PLATFORM_BOOTSTRAP_SCOPE);
  assert.equal(typeof server.ensurePlatformBootstrapApiKey, "function");
  assert.equal(server.isPlatformScope(PLATFORM_BOOTSTRAP_SCOPE), true);
  assert.deepEqual(Object.keys(server.DEDICATED_API_KEY_TYPES), ["session-directory-search"]);
});

test("the operator step creates one platform key, stores only its hash, and re-runs as a no-op", async () => {
  const app = createTestApp();
  const first = await ensurePlatformBootstrapApiKey(app.storage, { orgId: PLATFORM_ORG, operator: "khaliq" });
  assert.equal(first.status, "created");
  assert.ok(first.status === "created");
  assert.deepEqual(first.apiKey.scopes, [PLATFORM_BOOTSTRAP_SCOPE]);
  assert.equal(first.apiKey.name, PLATFORM_BOOTSTRAP_API_KEY_NAME);
  assert.equal(first.apiKey.keyHash, hashApiKey(first.key));

  const stored = await allKeys(app);
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored).includes(first.key), false, "plaintext must not be stored");
  const audit = await auditRows(app);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.identityId, "operator:khaliq");
  assert.equal(audit[0]?.metadata?.apiKeyId, first.apiKey.id);
  assert.equal(JSON.stringify(audit).includes(first.key), false, "plaintext must not be audited");

  const again = await ensurePlatformBootstrapApiKey(app.storage, { orgId: PLATFORM_ORG, operator: "khaliq" });
  assert.equal(again.status, "exists");
  assert.equal(again.apiKey.id, first.apiKey.id);
  assert.equal("key" in again, false);
  assert.equal((await allKeys(app)).length, 1);
  assert.equal((await auditRows(app)).length, 1);
});

test("a failed audit write revokes the key it just created", async () => {
  const app = createTestApp();
  const storage = {
    apiKeys: app.storage.apiKeys,
    audit: { ...app.storage.audit, write: async () => { throw new Error("audit down"); } },
  };
  await assert.rejects(
    ensurePlatformBootstrapApiKey(storage as never, { orgId: PLATFORM_ORG, operator: "khaliq" }),
    /audit down/,
  );
  const stored = await allKeys(app);
  assert.equal(stored.length, 1);
  assert.ok(stored[0]?.revokedAt);
  const rerun = await ensurePlatformBootstrapApiKey(app.storage, { orgId: PLATFORM_ORG, operator: "khaliq" });
  assert.equal(rerun.status, "created");
});

test("the platform key creates the search mint key once, with exactly its one scope", async () => {
  const app = createTestApp(ISSUER_ON);
  const platform = { "x-api-key": await platformKey(app) };

  const created = await assertJsonResponse<{
    status: string;
    key?: string;
    apiKey: { id: string; scopes: string[]; orgId: string };
  }>(await post(app, ROUTE, { type: "session-directory-search" }, platform), 201);
  assert.equal(created.status, "created");
  assert.deepEqual(created.apiKey.scopes, [SESSION_DIRECTORY_SEARCH_MINT_SCOPE]);
  assert.equal(created.apiKey.orgId, PLATFORM_ORG);
  assert.ok(created.key);

  const stored = await app.storage.apiKeys.getByHash(hashApiKey(created.key!));
  assert.deepEqual(stored?.scopes, [SESSION_DIRECTORY_SEARCH_MINT_SCOPE]);
  assert.equal(JSON.stringify(await allKeys(app)).includes(created.key!), false);
  assert.equal(JSON.stringify(await auditRows(app)).includes(created.key!), false);

  // The new key is the dedicated mint key the exchange endpoint accepts.
  const minted = await post(
    app,
    "/v1/tokens/session-directory-search",
    { subjectToken: searchSubject(), workspaceId: "ws_a" },
    { "x-api-key": created.key! },
  );
  assert.equal(minted.status, 201);

  const keysBefore = (await allKeys(app)).length;
  const auditBefore = (await auditRows(app)).length;
  const again = await assertJsonResponse<{ status: string; key?: string; apiKey: { id: string } }>(
    await post(app, ROUTE, { type: "session-directory-search" }, platform),
    200,
  );
  assert.equal(again.status, "exists");
  assert.equal(again.apiKey.id, created.apiKey.id);
  assert.equal(again.key, undefined);
  assert.equal((await allKeys(app)).length, keysBefore);
  assert.equal((await auditRows(app)).length, auditBefore);
});

test("the platform key cannot mint search tokens itself", async () => {
  const app = createTestApp(ISSUER_ON);
  const response = await post(
    app,
    "/v1/tokens/session-directory-search",
    { subjectToken: searchSubject(), workspaceId: "ws_a" },
    { "x-api-key": await platformKey(app) },
  );
  assert.equal(response.status, 403);
  const body = await response.json() as { accessToken?: string };
  assert.equal(body.accessToken, undefined);
});

test("the issuer stays off by default even once the mint key exists", async () => {
  const app = createTestApp();
  const created = await assertJsonResponse<{ key: string }>(
    await post(app, ROUTE, { type: "session-directory-search" }, { "x-api-key": await platformKey(app) }),
    201,
  );
  const response = await assertJsonResponse<{ code: string }>(
    await post(
      app,
      "/v1/tokens/session-directory-search",
      { subjectToken: searchSubject(), workspaceId: "ws_a" },
      { "x-api-key": created.key },
    ),
    503,
  );
  assert.equal(response.code, "session_directory_issuance_disabled");
});

test("wildcard, manage, mixed-scope, workspace and bearer callers are refused and audited", async () => {
  const app = createTestApp();
  const plain = async (scopes: string[]) =>
    ({ "x-api-key": (await seedPlainApiKey(app, { orgId: PLATFORM_ORG, name: "caller", scopes })).key });
  const workspaceToken = async () => {
    const key = `relay_ws_${"w".repeat(43)}`;
    await app.storage.apiKeys.create({
      orgId: PLATFORM_ORG,
      name: "ws",
      prefix: key.slice(0, 16),
      keyHash: hashApiKey(key),
      scopes: [PLATFORM_BOOTSTRAP_SCOPE],
      kind: "workspace_token",
      workspaceId: "ws_platform",
    });
    return { "x-api-key": key };
  };
  const bearer = (meta?: Record<string, string>) => ({
    authorization: `Bearer ${generateTestToken({ org: PLATFORM_ORG, scopes: [PLATFORM_BOOTSTRAP_SCOPE], meta })}`,
  });

  const cases: Array<[string, HeadersInit, string]> = [
    ["*", await plain(["*"]), "insufficient_scope"],
    ["relayauth:*:manage:*", await plain(["relayauth:*:manage:*"]), "insufficient_scope"],
    ["api-key manage", await plain(["relayauth:api-key:manage:*"]), "insufficient_scope"],
    ["search mint key", await plain([SESSION_DIRECTORY_SEARCH_MINT_SCOPE]), "insufficient_scope"],
    ["platform + extra", await plain([PLATFORM_BOOTSTRAP_SCOPE, "relayauth:token:read:*"]), "platform_key_required"],
    ["workspace token", await workspaceToken(), "platform_key_required"],
    ["identity JWT", bearer(), "platform_key_required"],
    ["JWT claiming api key meta", bearer({ apiKeyKind: "api_key", apiKeyId: "ak_x" }), "platform_key_required"],
    ["bearer wildcard", { authorization: `Bearer ${generateTestToken({ org: PLATFORM_ORG, scopes: ["*"] })}` }, "insufficient_scope"],
  ];
  const keysBefore = (await allKeys(app)).length;
  for (const [label, headers, code] of cases) {
    const body = await assertJsonResponse<{ code: string; key?: string }>(
      await post(app, ROUTE, { type: "session-directory-search" }, headers),
      403,
    );
    assert.equal(body.code, code, label);
    assert.equal(body.key, undefined, label);
  }
  assert.equal((await allKeys(app)).length, keysBefore, "no refused caller created a key");
  const denied = (await auditRows(app)).filter((row) => row.action === "scope.denied");
  assert.equal(denied.length, cases.length);

  const anonymous = await post(app, ROUTE, { type: "session-directory-search" }, {});
  assert.equal(anonymous.status, 401);
});

test("the platform scope cannot be created or delegated through the API by anyone", async () => {
  const app = createTestApp();
  const admin = await seedPlainApiKey(app, {
    orgId: PLATFORM_ORG,
    name: "admin",
    scopes: ["*", "relayauth:api-key:manage:*"],
  });
  // Even a key holding the exact literal plus manage cannot hand it on.
  const holder = await seedPlainApiKey(app, {
    orgId: PLATFORM_ORG,
    name: "holder",
    scopes: [PLATFORM_BOOTSTRAP_SCOPE, "relayauth:api-key:manage:*"],
  });
  for (const caller of [admin.key, holder.key]) {
    for (const [path, body] of [
      ["/v1/api-keys", { name: "escalate", scopes: [PLATFORM_BOOTSTRAP_SCOPE] }],
      ["/v1/tokens/workspace", { workspaceId: "ws_platform", scopes: [PLATFORM_BOOTSTRAP_SCOPE] }],
    ] as const) {
      const response = await assertJsonResponse<{ code: string }>(
        await post(app, path, body, { "x-api-key": caller }),
        403,
      );
      assert.equal(response.code, "scope_escalation", path);
    }
  }
  assert.equal(
    (await allKeys(app)).filter((key) => key.scopes.includes(PLATFORM_BOOTSTRAP_SCOPE)).length,
    1,
    "only the seeded holder carries the platform scope",
  );
});

test("the request names an allowlisted type and nothing else", async () => {
  const app = createTestApp();
  const platform = { "x-api-key": await platformKey(app) };
  const cases: Array<[unknown, string]> = [
    [{ type: "session-directory-search", scopes: ["*"] }, "invalid_body"],
    [{ type: "session-directory-search", orgId: "org_other" }, "invalid_body"],
    [{ type: "platform-bootstrap" }, "unknown_dedicated_key_type"],
    [{ type: "__proto__" }, "unknown_dedicated_key_type"],
    [{ type: "toString" }, "unknown_dedicated_key_type"],
    [{}, "unknown_dedicated_key_type"],
    [["session-directory-search"], "invalid_body"],
  ];
  for (const [body, code] of cases) {
    const response = await assertJsonResponse<{ code: string }>(await post(app, ROUTE, body, platform), 400);
    assert.equal(response.code, code, JSON.stringify(body));
  }
  assert.equal((await allKeys(app)).length, 1, "only the platform key exists");
  assert.equal(Object.isFrozen(DEDICATED_API_KEY_TYPES), true);
});
