import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify as verifySignature } from "node:crypto";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { SigningKeyConfigError } from "../lib/signing-keys.js";
import {
  assertSessionDirectoryIssuerConfig,
  normalizeTenantId,
  SESSION_DIRECTORY_SEARCH_MINT_SCOPE,
} from "../lib/session-directory-issuer.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
  seedStoredIdentity,
  TEST_RS256_PRIVATE_KEY_PEM,
} from "./test-helpers.js";

const GENERAL_ISSUER = "https://relayauth.dev";
const SEARCH_ISSUER = "https://relayauth.dev/session-directory";
const pem = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
};
const SEARCH_KEY = pem();
const NEXT_KEY = pem();
const ENABLED = {
  RELAYAUTH_ISSUER: GENERAL_ISSUER,
  RELAYAUTH_SESSION_DIRECTORY_ISSUANCE: "true",
  RELAYAUTH_SESSION_DIRECTORY_ISSUER: SEARCH_ISSUER,
  RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM: SEARCH_KEY,
};

type App = ReturnType<typeof createTestApp>;
const post = (app: App, path: string, body: unknown, headers: HeadersInit) =>
  app.request(createTestRequest("POST", path, body, headers), undefined, app.bindings);
const subject = (claims: Partial<RelayAuthTokenClaims> = {}) =>
  generateTestToken({
    iss: GENERAL_ISSUER,
    aud: ["relayhistory"],
    org: "relay_org_a",
    wks: "relay_ws_a",
    scopes: ["rth:read"],
    sponsorId: "user_a",
    ...claims,
  });
const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

async function harness(bindings: Parameters<typeof createTestApp>[0] = ENABLED) {
  const app = createTestApp(bindings);
  await seedStoredIdentity(app, {
    id: "agent_operator",
    name: "Operator",
    type: "agent",
    orgId: "org_operator",
    workspaceId: "ws_operator",
    sponsorId: "user_operator",
    sponsorChain: ["user_operator", "agent_operator"],
    scopes: [],
    roles: [],
    metadata: {},
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  const admin = {
    Authorization: `Bearer ${generateTestToken({
      iss: GENERAL_ISSUER,
      sub: "agent_operator",
      org: "org_operator",
      wks: "ws_operator",
      scopes: ["relayauth:api-key:manage:*", "*"],
    })}`,
  };
  const key = async (scopes: string[]) => {
    const created = await assertJsonResponse<{ key: string; apiKey?: { id: string } }>(
      await post(app, "/v1/api-keys", { name: "search-minter", scopes }, admin),
      201,
    );
    return created.key;
  };
  const mintKey = await key([SESSION_DIRECTORY_SEARCH_MINT_SCOPE]);
  const exchange = (body: unknown, apiKey = mintKey) =>
    post(app, "/v1/tokens/session-directory-search", body, { "x-api-key": apiKey });
  return { app, admin, key, mintKey, exchange };
}

async function refused(response: Response, status: number, code: string) {
  const body = await assertJsonResponse<{ code: string; accessToken?: string }>(response, status);
  assert.equal(body.code, code);
  assert.equal(body.accessToken, undefined);
}

test("mints a 60s search token whose tenant comes only from the subject", async () => {
  const { app, exchange } = await harness();
  const before = Math.floor(Date.now() / 1000);
  const body = await assertJsonResponse<{ accessToken: string; tokenType: string }>(
    await exchange({ subjectToken: subject(), workspaceId: "ws_a", orgId: "org_b", role: "postgres" }),
    201,
  );
  const claims = decode(body.accessToken);
  assert.equal(claims.iss, SEARCH_ISSUER);
  assert.equal(claims.aud, "session-directory-search");
  assert.equal(claims.sub, "user_a");
  assert.equal(claims.role, "session_directory_search_worker");
  assert.deepEqual(claims.app_metadata, { org_id: "org_a", workspace_ids: ["ws_a"] });
  assert.ok(claims.iat >= before);
  assert.equal(claims.nbf, claims.iat);
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(body.tokenType, "Bearer");
  assert.equal(Object.hasOwn(body, "refreshToken"), false);

  const jwks = await assertJsonResponse<{ keys: JsonWebKey[] }>(
    await app.request("/.well-known/session-directory/jwks.json", undefined, app.bindings),
    200,
  );
  const [header, payload, signature] = body.accessToken.split(".");
  const { kid, alg } = JSON.parse(Buffer.from(header!, "base64url").toString());
  assert.equal(alg, "RS256");
  const jwk = jwks.keys.find((candidate) => (candidate as { kid?: string }).kid === kid);
  assert.ok(jwk);
  assert.equal(
    verifySignature(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwk as never, format: "jwk" }),
      Buffer.from(signature!, "base64url"),
    ),
    true,
  );
});

test("mints are rate limited per subject and workspace", async () => {
  const { exchange } = await harness();
  const subjectToken = subject({ sponsorId: "user_rate_limited" });
  for (let index = 0; index < 120; index += 1) {
    assert.equal((await exchange({ subjectToken, workspaceId: "ws_a" })).status, 201);
  }
  await refused(await exchange({ subjectToken, workspaceId: "ws_a" }), 429, "rate_limited");
});

test("search token never outlives its subject", async () => {
  const { exchange } = await harness();
  const now = Math.floor(Date.now() / 1000);
  const body = await assertJsonResponse<{ accessToken: string }>(
    await exchange({ subjectToken: subject({ exp: now + 10 }), workspaceId: "ws_a" }),
    201,
  );
  assert.equal(decode(body.accessToken).exp, now + 10);
});

test("issuance is off by default and with any value but true", async () => {
  for (const value of [undefined, "1", "TRUE"]) {
    const { exchange } = await harness({ ...ENABLED, RELAYAUTH_SESSION_DIRECTORY_ISSUANCE: value });
    await refused(
      await exchange({ subjectToken: subject(), workspaceId: "ws_a" }),
      503,
      "session_directory_issuance_disabled",
    );
  }
});

test("every binding rule refuses", async () => {
  const { exchange } = await harness();
  const now = Math.floor(Date.now() / 1000);
  const cases: [Partial<RelayAuthTokenClaims>, string, number, string][] = [
    [{}, "ws_b", 403, "workspace_mismatch"],
    [{ wks: "" }, "ws_a", 403, "subject_tenant_missing"],
    [{ scopes: ["rth:sync"] }, "ws_a", 403, "subject_scope_missing"],
    [{ scopes: ["*"] }, "ws_a", 403, "subject_scope_missing"],
    [{ aud: ["relayfile"] }, "ws_a", 403, "subject_audience_refused"],
    [{ token_type: "refresh" }, "ws_a", 403, "subject_not_access_token"],
    [{ meta: { tokenClass: "migration_assertion" } }, "ws_a", 403, "subject_class_refused"],
    [{ meta: { tokenClass: "session_directory_search" } }, "ws_a", 403, "subject_class_refused"],
    [{ iss: "https://attacker.example" }, "ws_a", 401, "subject_token_invalid"],
    [{ exp: now - 120 }, "ws_a", 401, "subject_token_invalid"],
  ];
  for (const [claims, workspaceId, status, code] of cases) {
    await refused(await exchange({ subjectToken: subject(claims), workspaceId }), status, code);
  }
  await refused(await exchange({ subjectToken: "not-a-jwt", workspaceId: "ws_a" }), 401, "subject_token_invalid");
  await refused(await exchange({ workspaceId: "ws_a" }), 400, "subjectToken_required");
  await refused(await exchange({ subjectToken: subject() }), 400, "workspaceId_required");
});

test("a token issued by this endpoint cannot be exchanged again", async () => {
  const { exchange } = await harness();
  const first = await assertJsonResponse<{ accessToken: string }>(
    await exchange({ subjectToken: subject(), workspaceId: "ws_a" }),
    201,
  );
  await refused(await exchange({ subjectToken: first.accessToken, workspaceId: "ws_a" }), 401, "subject_token_invalid");
});

test("a revoked subject is refused", async () => {
  const { app, exchange } = await harness();
  const jti = crypto.randomUUID();
  await app.storage.revocations.revoke(jti, Math.floor(Date.now() / 1000) + 600);
  await refused(await exchange({ subjectToken: subject({ jti }), workspaceId: "ws_a" }), 401, "subject_token_invalid");
});

test("only a key with the one literal scope can mint", async () => {
  const { app, admin, key, exchange } = await harness();
  const body = { subjectToken: subject(), workspaceId: "ws_a" };
  await refused(await exchange(body, await key(["*"])), 403, "assertion_key_required");
  await refused(
    await exchange(body, await key([SESSION_DIRECTORY_SEARCH_MINT_SCOPE, "relayauth:token:read:*"])),
    403,
    "assertion_key_required",
  );
  await refused(await post(app, "/v1/tokens/session-directory-search", body, admin), 403, "assertion_key_required");
  const wrongScope = await exchange(body, await key(["relayauth:assertion:create:relayhistory"]));
  assert.equal(wrongScope.status, 403);
});

test("tenant ids lose exactly one relay_ prefix", async () => {
  assert.equal(normalizeTenantId("relay_ws_a"), "ws_a");
  assert.equal(normalizeTenantId("ws_a"), "ws_a");
  assert.equal(normalizeTenantId("relay_relay_ws_a"), "relay_ws_a");
  const { exchange } = await harness();
  for (const wks of ["relay_ws_a", "ws_a"]) {
    const body = await assertJsonResponse<{ accessToken: string }>(
      await exchange({ subjectToken: subject({ wks }), workspaceId: "ws_a" }),
      201,
    );
    assert.deepEqual(decode(body.accessToken).app_metadata.workspace_ids, ["ws_a"]);
  }
  await refused(
    await exchange({ subjectToken: subject({ wks: "relay_relay_ws_a" }), workspaceId: "ws_a" }),
    403,
    "workspace_mismatch",
  );
});

test("the search JWKS publishes only its own slots, with a short cache", async () => {
  const app = createTestApp({ ...ENABLED, RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM_NEXT: NEXT_KEY });
  const response = await app.request("/.well-known/session-directory/jwks.json", undefined, app.bindings);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  const search = (await response.json()) as { keys: { kid: string }[] };
  assert.equal(search.keys.length, 2);
  const general = (await (
    await app.request("/.well-known/jwks.json", undefined, app.bindings)
  ).json()) as { keys: { kid: string }[] };
  const generalKids = new Set(general.keys.map((key) => key.kid));
  assert.equal(search.keys.some((key) => generalKids.has(key.kid)), false);

  const off = createTestApp({});
  assert.equal((await off.request("/.well-known/session-directory/jwks.json", undefined, off.bindings)).status, 404);
});

test("config that overlaps the general issuer is refused", async () => {
  const base = { ...ENABLED, RELAYAUTH_SIGNING_KEY_PEM: TEST_RS256_PRIVATE_KEY_PEM };
  await assertSessionDirectoryIssuerConfig(base);
  await assertSessionDirectoryIssuerConfig({ RELAYAUTH_SIGNING_KEY_PEM: TEST_RS256_PRIVATE_KEY_PEM });
  for (const bad of [
    { ...base, RELAYAUTH_SESSION_DIRECTORY_ISSUER: GENERAL_ISSUER },
    { ...base, RELAYAUTH_SESSION_DIRECTORY_ISSUER: undefined },
    { ...base, RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM: undefined },
    { ...base, RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM: TEST_RS256_PRIVATE_KEY_PEM },
    { ...base, RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM_PREVIOUS: TEST_RS256_PRIVATE_KEY_PEM },
  ]) {
    await assert.rejects(assertSessionDirectoryIssuerConfig(bad), SigningKeyConfigError);
  }
});
