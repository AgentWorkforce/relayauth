import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { AppEnv } from "../env.js";
import {
  generateTestToken,
  TEST_RS256_PRIVATE_KEY_PEM,
  TEST_RS256_PUBLIC_KEY_PEM,
} from "./test-helpers.js";

type StoredApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  orgId: string;
  lastUsedAt?: string;
  revokedAt?: string | null;
};

type ApiKeyStorageLike = {
  getByHash(keyHash: string): Promise<StoredApiKey | null>;
  touchLastUsed(id: string, usedAt: string): Promise<void>;
};

type AuthenticateFailure = {
  ok: false;
  error: string;
  code: string;
  status: 401;
};

type AuthenticateSuccess = {
  ok: true;
  claims: RelayAuthTokenClaims;
};

type AuthenticateBearerOrApiKey = (
  authorization: string | undefined,
  apiKey: string | undefined,
  env: AppEnv["Bindings"],
  apiKeys: ApiKeyStorageLike,
  options?: {
    deferTask?: (task: Promise<unknown>) => void;
    now?: () => number;
  },
) => Promise<AuthenticateSuccess | AuthenticateFailure>;

const TEST_BINDINGS: AppEnv["Bindings"] = {
  INTERNAL_SECRET: "internal-test-secret",
  RELAYAUTH_SIGNING_KEY_PEM: TEST_RS256_PRIVATE_KEY_PEM,
  RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: TEST_RS256_PUBLIC_KEY_PEM,
};

function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

async function loadAuthenticateBearerOrApiKey(): Promise<AuthenticateBearerOrApiKey> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../lib/auth.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected auth module at ../lib/auth.js: ${message}`);
  }

  assert.equal(
    typeof moduleRecord.authenticateBearerOrApiKey,
    "function",
    "auth module should export authenticateBearerOrApiKey()",
  );

  return moduleRecord.authenticateBearerOrApiKey as AuthenticateBearerOrApiKey;
}

function createApiKeyStorage(records: StoredApiKey[]) {
  const byHash = new Map<string, StoredApiKey>();
  const lookupHashes: string[] = [];
  const touched: Array<{ id: string; usedAt: string }> = [];

  for (const record of records) {
    byHash.set(hashApiKey(`${record.prefix}_plaintext_fixture`), record);
  }

  const storage: ApiKeyStorageLike = {
    async getByHash(keyHash) {
      lookupHashes.push(keyHash);
      return byHash.get(keyHash) ?? null;
    },
    async touchLastUsed(id, usedAt) {
      touched.push({ id, usedAt });
    },
  };

  return { storage, lookupHashes, touched, byHash };
}

function createStoredApiKey(
  overrides: Partial<StoredApiKey> = {},
): StoredApiKey {
  return {
    id: overrides.id ?? "ak_test_auth_helper",
    name: overrides.name ?? "auth-helper-test",
    prefix: overrides.prefix ?? "rak_test_auth",
    scopes: overrides.scopes ?? ["relayauth:identity:manage:*"],
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.lastUsedAt ? { lastUsedAt: overrides.lastUsedAt } : {}),
    revokedAt: overrides.revokedAt ?? null,
  };
}

test("changing one byte of the plaintext API key fails verification via SHA-256 lookup isolation", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const validPlaintext = "rak_test_auth_plaintext_fixture";
  const storedKey = createStoredApiKey({
    prefix: "rak_test_auth",
  });
  const { storage, lookupHashes } = createApiKeyStorage([storedKey]);

  const mutatedLastChar = validPlaintext.endsWith("e")
    ? `${validPlaintext.slice(0, -1)}f`
    : `${validPlaintext.slice(0, -1)}e`;

  const auth = await authenticateBearerOrApiKey(
    undefined,
    mutatedLastChar,
    TEST_BINDINGS,
    storage,
  );

  assert.deepEqual(lookupHashes, [hashApiKey(mutatedLastChar)]);
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
  assert.match(auth.error, /api key|invalid/i);
});

test("authenticateBearerOrApiKey accepts a valid bearer JWT and returns its claims", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const bearerClaims: Partial<RelayAuthTokenClaims> = {
    sub: "agent_bearer_ok",
    org: "org_bearer_ok",
    wks: "ws_bearer_ok",
    sponsorId: "user_bearer_ok",
    sponsorChain: ["user_bearer_ok", "agent_bearer_ok"],
    scopes: ["relayauth:identity:manage:*"],
  };
  const authorization = `Bearer ${generateTestToken(bearerClaims)}`;
  const { storage } = createApiKeyStorage([]);

  const auth = await authenticateBearerOrApiKey(
    authorization,
    undefined,
    TEST_BINDINGS,
    storage,
  );

  assert.equal(auth.ok, true);
  assert.equal(auth.claims.sub, "agent_bearer_ok");
  assert.equal(auth.claims.org, "org_bearer_ok");
  assert.deepEqual(auth.claims.scopes, ["relayauth:identity:manage:*"]);
});

test("authenticateBearerOrApiKey accepts a valid x-api-key and returns synthesized claims with the API key scopes", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const plaintext = "rak_test_auth_plaintext_fixture";
  const storedKey = createStoredApiKey({
    id: "ak_api_key_auth_ok",
    orgId: "org_api_key_auth",
    scopes: ["relayauth:identity:manage:*", "relayauth:token:create:*"],
  });
  const { storage, touched } = createApiKeyStorage([storedKey]);

  const deferred: Promise<unknown>[] = [];
  const auth = await authenticateBearerOrApiKey(
    undefined,
    plaintext,
    TEST_BINDINGS,
    storage,
    { deferTask: (task) => deferred.push(task) },
  );
  await Promise.all(deferred);

  assert.equal(auth.ok, true);
  assert.equal(auth.claims.org, "org_api_key_auth");
  assert.deepEqual(auth.claims.scopes, ["relayauth:identity:manage:*", "relayauth:token:create:*"]);
  assert.equal(typeof auth.claims.sub, "string");
  assert.ok(Array.isArray(auth.claims.sponsorChain));
  assert.deepEqual(touched.map((entry) => entry.id), ["ak_api_key_auth_ok"]);
});

test("authenticateBearerOrApiKey returns 401 when neither bearer nor x-api-key is present", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const { storage } = createApiKeyStorage([]);

  const auth = await authenticateBearerOrApiKey(
    undefined,
    undefined,
    TEST_BINDINGS,
    storage,
  );

  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
  assert.match(auth.error, /authorization|api key|credential/i);
});

test("when both are present and conflict, a valid bearer wins and API-key lookup is short-circuited", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const authorization = `Bearer ${generateTestToken({
    sub: "agent_bearer_precedence",
    org: "org_bearer_precedence",
    wks: "ws_bearer_precedence",
    sponsorId: "user_bearer_precedence",
    sponsorChain: ["user_bearer_precedence", "agent_bearer_precedence"],
    scopes: ["relayauth:identity:manage:*"],
  })}`;
  const revokedKey = createStoredApiKey({
    id: "ak_revoked_should_not_be_checked",
    revokedAt: new Date().toISOString(),
  });
  const { storage, lookupHashes } = createApiKeyStorage([revokedKey]);

  const auth = await authenticateBearerOrApiKey(
    authorization,
    "rak_test_auth_plaintext_fixture",
    TEST_BINDINGS,
    storage,
  );

  assert.equal(auth.ok, true);
  assert.equal(auth.claims.sub, "agent_bearer_precedence");
  assert.deepEqual(lookupHashes, []);
});

test("authenticateBearerOrApiKey updates last_used_at when an API key authenticates", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const { storage, touched } = createApiKeyStorage([
    createStoredApiKey({
      id: "ak_touch_last_used",
      scopes: ["relayauth:identity:manage:*"],
    }),
  ]);

  const deferred: Promise<unknown>[] = [];
  const auth = await authenticateBearerOrApiKey(
    undefined,
    "rak_test_auth_plaintext_fixture",
    TEST_BINDINGS,
    storage,
    { deferTask: (task) => deferred.push(task) },
  );
  await Promise.all(deferred);

  assert.equal(auth.ok, true);
  assert.equal(touched.length, 1, "API-key authentication should mark the key as used");
  assert.equal(touched[0]?.id, "ak_touch_last_used");
  assert.equal(Number.isNaN(Date.parse(touched[0]?.usedAt ?? "")), false);
});

test("authenticateBearerOrApiKey skips last_used_at writes while the stored timestamp is fresh", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const now = Date.parse("2026-07-13T14:00:00.000Z");
  const { storage, touched } = createApiKeyStorage([
    createStoredApiKey({
      id: "ak_touch_fresh",
      lastUsedAt: new Date(now - 60_000).toISOString(),
    }),
  ]);
  const deferred: Promise<unknown>[] = [];

  const auth = await authenticateBearerOrApiKey(
    undefined,
    "rak_test_auth_plaintext_fixture",
    TEST_BINDINGS,
    storage,
    {
      now: () => now,
      deferTask: (task) => deferred.push(task),
    },
  );

  assert.equal(auth.ok, true);
  assert.equal(deferred.length, 0, "fresh API keys must not enqueue a write");
  assert.deepEqual(touched, []);
});

test("authenticateBearerOrApiKey defers stale last_used_at writes without blocking authentication", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const now = Date.parse("2026-07-13T14:00:00.000Z");
  const storedKey = createStoredApiKey({
    id: "ak_touch_stale_nonblocking",
    lastUsedAt: new Date(now - 10 * 60_000).toISOString(),
  });
  let releaseTouch!: () => void;
  const touchGate = new Promise<void>((resolve) => {
    releaseTouch = resolve;
  });
  let touchStarted = false;
  const storage: ApiKeyStorageLike = {
    getByHash: async () => storedKey,
    touchLastUsed: async () => {
      touchStarted = true;
      await touchGate;
    },
  };
  const deferred: Promise<unknown>[] = [];

  const auth = await authenticateBearerOrApiKey(
    undefined,
    "rak_test_auth_plaintext_fixture",
    TEST_BINDINGS,
    storage,
    {
      now: () => now,
      deferTask: (task) => deferred.push(task),
    },
  );

  assert.equal(auth.ok, true, "authentication must complete before the write resolves");
  assert.equal(deferred.length, 1);
  await Promise.resolve();
  assert.equal(touchStarted, true);
  releaseTouch();
  await Promise.all(deferred);
});

test("repeated authentication of the same stale key enqueues only one debounced write", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const now = Date.parse("2026-07-13T14:00:00.000Z");
  const { storage, touched } = createApiKeyStorage([
    createStoredApiKey({
      id: "ak_touch_stale_debounced",
      lastUsedAt: new Date(now - 10 * 60_000).toISOString(),
    }),
  ]);
  const deferred: Promise<unknown>[] = [];
  const options = {
    now: () => now,
    deferTask: (task: Promise<unknown>) => deferred.push(task),
  };

  const [first, second] = await Promise.all([
    authenticateBearerOrApiKey(
      undefined,
      "rak_test_auth_plaintext_fixture",
      TEST_BINDINGS,
      storage,
      options,
    ),
    authenticateBearerOrApiKey(
      undefined,
      "rak_test_auth_plaintext_fixture",
      TEST_BINDINGS,
      storage,
      options,
    ),
  ]);
  await Promise.all(deferred);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(deferred.length, 1);
  assert.equal(touched.length, 1);
});

test("a deferred last_used_at failure never turns valid API-key authentication into a 500", async () => {
  const authenticateBearerOrApiKey = await loadAuthenticateBearerOrApiKey();
  const now = Date.parse("2026-07-13T14:00:00.000Z");
  const storedKey = createStoredApiKey({
    id: "ak_touch_failure_isolated",
    lastUsedAt: new Date(now - 10 * 60_000).toISOString(),
  });
  const storage: ApiKeyStorageLike = {
    getByHash: async () => storedKey,
    touchLastUsed: async () => {
      throw new Error("write failed");
    },
  };
  const deferred: Promise<unknown>[] = [];

  const auth = await authenticateBearerOrApiKey(
    undefined,
    "rak_test_auth_plaintext_fixture",
    TEST_BINDINGS,
    storage,
    {
      now: () => now,
      deferTask: (task) => deferred.push(task),
    },
  );
  await Promise.all(deferred);

  assert.equal(auth.ok, true);
});
