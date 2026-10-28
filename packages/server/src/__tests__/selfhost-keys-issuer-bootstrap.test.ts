import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { TokenVerifier } from "@relayauth/sdk";
import type { AppConfig } from "../env.js";
import { hashApiKey } from "../lib/api-keys.js";
import {
  BOOTSTRAP_API_KEY_SCOPE,
  ensureBootstrapApiKey,
} from "../lib/bootstrap-api-key.js";
import { DEFAULT_ISSUER, resolveIssuer, signToken } from "../lib/sign.js";
import {
  assertSigningKeyConfig,
  resolvePublishedSigningKeys,
  SigningKeyConfigError,
} from "../lib/signing-keys.js";
import { verifyRs256Token } from "../lib/token-verifier.js";
import { createApp, readEnvOrFile, startServer } from "../server.js";
import { createTestStorage } from "./test-helpers.js";

type KeyPair = { privatePem: string; publicPem: string };

function keyPair(): KeyPair & { pkcs1Pem: string; encryptedPem: string; pkcs1PublicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    pkcs1Pem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs1PublicPem: publicKey.export({ type: "pkcs1", format: "pem" }).toString(),
    encryptedPem: privateKey
      .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "lab-only" })
      .toString(),
  };
}

const KEY_A = keyPair();
const KEY_B = keyPair();
const KEY_C = keyPair();
const BOOTSTRAP_KEY = "rak_selfhost_bootstrap_test_value_0123456789abcdef";

function decodeSegment<T>(token: string, index: number): T {
  return JSON.parse(Buffer.from(token.split(".")[index], "base64url").toString("utf8")) as T;
}

function claims(overrides: Partial<RelayAuthTokenClaims> = {}): RelayAuthTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "agent_test",
    org: "org_test",
    wks: "ws_test",
    scopes: ["rth:read"],
    sponsorId: "user_test",
    sponsorChain: ["user_test", "agent_test"],
    token_type: "access",
    iss: DEFAULT_ISSUER,
    aud: ["relayauth"],
    exp: now + 300,
    iat: now,
    jti: `tok_${crypto.randomUUID()}`,
    ...overrides,
  };
}

async function fetchJwks(config: Partial<AppConfig>) {
  const storage = createTestStorage();
  try {
    const app = createApp({ storage, defaultBindings: { INTERNAL_SECRET: "s", ...config } });
    const response = await app.request("/.well-known/jwks.json");
    assert.equal(response.status, 200);
    return (await response.json()) as { keys: Array<JsonWebKey & { kid: string }> };
  } finally {
    await storage.close();
  }
}

test("JWKS publishes current, next and previous keys with stable thumbprint kids", async () => {
  const config = {
    RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: KEY_A.publicPem,
    RELAYAUTH_SIGNING_KEY_PEM_NEXT: KEY_B.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS: KEY_C.publicPem,
  };
  const first = await fetchJwks(config);
  const second = await fetchJwks(config);

  assert.equal(first.keys.length, 3);
  assert.deepEqual(first.keys.map((key) => key.kid), second.keys.map((key) => key.kid));
  assert.equal(new Set(first.keys.map((key) => key.kid)).size, 3);
  for (const key of first.keys) {
    assert.equal("d" in key, false, "JWKS must never expose private material");
    assert.equal(key.alg, "RS256");
  }

  // A slot's kid is the same whether it holds the private or public half.
  const fromPublic = await resolvePublishedSigningKeys({ RELAYAUTH_SIGNING_KEY_PEM_NEXT: KEY_B.publicPem });
  const fromPrivate = await resolvePublishedSigningKeys({ RELAYAUTH_SIGNING_KEY_PEM_NEXT: KEY_B.privatePem });
  assert.equal(fromPublic[0]?.kid, fromPrivate[0]?.kid);
  assert.equal(fromPublic[0]?.kid, first.keys[1]?.kid);
});

test("JWKS derives the current public key when only the private PEM is bound", async () => {
  const jwks = await fetchJwks({ RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem });
  const withPublic = await fetchJwks({
    RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: KEY_A.publicPem,
  });
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]?.kid, withPublic.keys[0]?.kid);
});

test("JWKS deduplicates a key configured in two slots", async () => {
  const jwks = await fetchJwks({
    RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS: KEY_A.publicPem,
  });
  assert.equal(jwks.keys.length, 1);
});

test("rotation: tokens signed by the old current key verify once it moves to previous; new tokens use the new kid", async () => {
  const before = {
    RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_NEXT: KEY_B.publicPem,
  };
  const after = {
    RELAYAUTH_SIGNING_KEY_PEM: KEY_B.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS: KEY_A.publicPem,
  };

  const oldToken = await signToken(claims(), before);
  const newToken = await signToken(claims(), after);
  const [oldKid, newKid] = [oldToken, newToken].map(
    (token) => decodeSegment<{ kid: string }>(token, 0).kid,
  );
  assert.notEqual(oldKid, newKid);

  const publishedBefore = (await resolvePublishedSigningKeys(before)).map((key) => key.kid);
  assert.deepEqual(publishedBefore, [oldKid, newKid], "next key is pre-published");

  assert.equal((await verifyRs256Token(oldToken, after)).sub, "agent_test");
  assert.equal((await verifyRs256Token(newToken, after)).sub, "agent_test");

  // Once the previous key is dropped, its tokens stop verifying.
  await assert.rejects(verifyRs256Token(oldToken, { RELAYAUTH_SIGNING_KEY_PEM: KEY_B.privatePem }));
});

test("RELAYAUTH_ISSUER defaults to https://relayauth.dev and is trimmed when set", () => {
  assert.equal(resolveIssuer({}), "https://relayauth.dev");
  assert.equal(resolveIssuer({ RELAYAUTH_ISSUER: "  " }), "https://relayauth.dev");
  assert.equal(
    resolveIssuer({ RELAYAUTH_ISSUER: " https://auth.example.internal " }),
    "https://auth.example.internal",
  );
});

test("discovery advertises RELAYAUTH_ISSUER when set", async () => {
  const storage = createTestStorage();
  try {
    const app = createApp({
      storage,
      defaultBindings: {
        INTERNAL_SECRET: "s",
        BASE_URL: "http://127.0.0.1:19380",
        RELAYAUTH_ISSUER: "https://auth.example.internal",
      },
    });
    const response = await app.request("/.well-known/agent-configuration");
    const body = (await response.json()) as { issuer: string; jwks_uri: string };
    assert.equal(body.issuer, "https://auth.example.internal");
    assert.equal(body.jwks_uri, "http://127.0.0.1:19380/.well-known/jwks.json");
  } finally {
    await storage.close();
  }
});

test("bootstrap api key is seeded idempotently, hash-only, and mints History assertions with the configured issuer", async () => {
  const storage = createTestStorage();
  try {
    const created = await ensureBootstrapApiKey(storage, `${BOOTSTRAP_KEY}\n`);
    assert.equal(created.status, "created");
    const again = await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY);
    assert.deepEqual(again, { ...created, status: "exists" });

    const stored = await storage.apiKeys.getByHash(hashApiKey(BOOTSTRAP_KEY));
    assert.ok(stored);
    assert.deepEqual(stored.scopes, [BOOTSTRAP_API_KEY_SCOPE]);
    assert.equal(stored.orgId, "org_selfhost");
    assert.equal(JSON.stringify(stored).includes(BOOTSTRAP_KEY), false, "raw key must not be stored");

    const issuer = "http://relayauth.selfhost.test";
    const config = {
      INTERNAL_SECRET: "s",
      RELAYAUTH_ISSUER: issuer,
      RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
      RELAYAUTH_SIGNING_KEY_PEM_NEXT: KEY_B.publicPem,
    };
    const app = createApp({ storage, defaultBindings: config });
    const response = await app.request("/v1/tokens/relayhistory-assertion", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": BOOTSTRAP_KEY },
      body: JSON.stringify({
        orgId: "org_a",
        workspaceId: "ws_a",
        sponsorId: "user_a",
        scopes: ["rth:sync"],
        expiresIn: 60,
        historyOrigin: "http://127.0.0.1:18780",
      }),
    });
    assert.equal(response.status, 201);
    const { accessToken } = (await response.json()) as { accessToken: string };
    const payload = decodeSegment<RelayAuthTokenClaims>(accessToken, 1);
    assert.equal(payload.iss, issuer);
    assert.deepEqual(payload.aud, ["http://127.0.0.1:18780"]);

    // External verifier path: published JWKS + pinned issuer/audience.
    const jwks = await (await app.request("/.well-known/jwks.json")).json();
    const verifier = new TokenVerifier({
      jwksUrl: `data:application/json,${encodeURIComponent(JSON.stringify(jwks))}`,
      issuer,
      audience: ["http://127.0.0.1:18780"],
    });
    assert.equal((await verifier.verify(accessToken)).wks, "ws_a");
    await assert.rejects(
      new TokenVerifier({
        jwksUrl: `data:application/json,${encodeURIComponent(JSON.stringify(jwks))}`,
        issuer: DEFAULT_ISSUER,
      }).verify(accessToken),
    );
  } finally {
    await storage.close();
  }
});

test("bootstrap api key reports a revoked key instead of resurrecting it, and rejects short values", async () => {
  const storage = createTestStorage();
  try {
    const created = await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY);
    await storage.apiKeys.revoke(created.id, new Date().toISOString());
    assert.equal((await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY)).status, "revoked");
    await assert.rejects(ensureBootstrapApiKey(storage, "short"), /at least 32/);
  } finally {
    await storage.close();
  }
});

test("readEnvOrFile prefers the variable, falls back to the _FILE contents", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relayauth-envfile-"));
  try {
    const file = path.join(dir, "secret");
    writeFileSync(file, "from-file\n", { mode: 0o600 });
    assert.equal(readEnvOrFile("X", { X_FILE: file }), "from-file\n");
    assert.equal(readEnvOrFile("X", { X: "direct", X_FILE: file }), "direct");
    assert.equal(readEnvOrFile("X", {}), undefined);
    assert.throws(() => readEnvOrFile("X", { X_FILE: path.join(dir, "missing") }), /X_FILE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is refused instead of advertising the wrong kid", async () => {
  // Matching public half: accepted, same kid as derived from the private key.
  const matching = await assertSigningKeyConfig({
    RELAYAUTH_SIGNING_KEY_PEM: KEY_B.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: KEY_B.publicPem,
  });
  const derived = await assertSigningKeyConfig({ RELAYAUTH_SIGNING_KEY_PEM: KEY_B.privatePem });
  assert.equal(matching[0]?.kid, derived[0]?.kid);

  // After rotating to B, _PUBLIC still holds A: every path refuses.
  const stale = {
    RELAYAUTH_SIGNING_KEY_PEM: KEY_B.privatePem,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: KEY_A.publicPem,
  };
  await assert.rejects(assertSigningKeyConfig(stale), (error: unknown) => {
    assert.ok(error instanceof SigningKeyConfigError);
    assert.match(error.message, /RELAYAUTH_SIGNING_KEY_PEM_PUBLIC does not match/);
    return true;
  });
  await assert.rejects(signToken(claims(), stale), /does not match/);

  const storage = createTestStorage();
  try {
    await assert.rejects(
      startServer({ storage, port: 0, config: { INTERNAL_SECRET: "s", ...stale } }),
      /does not match/,
    );
  } finally {
    await storage.close();
  }
});

test("only unencrypted PKCS#8 / SPKI PEMs are accepted, with actionable errors", async () => {
  await assert.rejects(
    assertSigningKeyConfig({ RELAYAUTH_SIGNING_KEY_PEM: KEY_A.pkcs1Pem }),
    /RELAYAUTH_SIGNING_KEY_PEM is a PKCS#1 key .*openssl pkcs8 -topk8 -nocrypt/,
  );
  await assert.rejects(
    assertSigningKeyConfig({ RELAYAUTH_SIGNING_KEY_PEM: KEY_A.encryptedPem }),
    /RELAYAUTH_SIGNING_KEY_PEM is an encrypted PKCS#8 key/,
  );
  await assert.rejects(
    assertSigningKeyConfig({ RELAYAUTH_SIGNING_KEY_PEM: KEY_A.publicPem }),
    /must be a PKCS#8 private key/,
  );
  await assert.rejects(
    assertSigningKeyConfig({
      RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
      RELAYAUTH_SIGNING_KEY_PEM_NEXT: KEY_B.pkcs1Pem,
    }),
    /RELAYAUTH_SIGNING_KEY_PEM_NEXT is a PKCS#1 key/,
  );
  await assert.rejects(
    assertSigningKeyConfig({
      RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem,
      RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS: KEY_C.pkcs1PublicPem,
    }),
    /RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS is a PKCS#1 public key/,
  );
  // Unlabelled PKCS#8 body (bare base64) in the signing slot keeps working.
  const bare = KEY_A.privatePem.replace(/-----[^-]+-----/gu, "").replace(/\s+/gu, "");
  const [fromBare] = await assertSigningKeyConfig({ RELAYAUTH_SIGNING_KEY_PEM: bare });
  const [fromPem] = await assertSigningKeyConfig({ RELAYAUTH_SIGNING_KEY_PEM: KEY_A.privatePem });
  assert.equal(fromBare?.kid, fromPem?.kid);
});

test("bootstrap api key: a concurrent insert of the same key resolves to exists", async () => {
  const storage = createTestStorage();
  try {
    // Simulate another process winning the race between getByHash and create.
    const realGetByHash = storage.apiKeys.getByHash.bind(storage.apiKeys);
    const realCreate = storage.apiKeys.create.bind(storage.apiKeys);
    let reads = 0;
    storage.apiKeys.getByHash = async (hash) => (reads++ === 0 ? null : realGetByHash(hash));
    storage.apiKeys.create = async (input) => {
      await realCreate(input);
      throw new Error("UNIQUE constraint failed: api_keys.key_hash");
    };
    const result = await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY);
    assert.equal(result.status, "exists");

    // A create failure that is not a race still surfaces.
    storage.apiKeys.getByHash = async () => null;
    storage.apiKeys.create = async () => {
      throw new Error("disk full");
    };
    await assert.rejects(ensureBootstrapApiKey(storage, `${BOOTSTRAP_KEY}x`), /disk full/);
  } finally {
    await storage.close();
  }
});

test("bootstrap api key reports an org mismatch without moving the key", async () => {
  const storage = createTestStorage();
  try {
    await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY, { orgId: "org_one" });
    const same = await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY, { orgId: "org_one" });
    assert.equal(same.status, "exists");
    assert.equal("orgMismatch" in same, false);
    const moved = await ensureBootstrapApiKey(storage, BOOTSTRAP_KEY, { orgId: "org_two" });
    assert.equal(moved.status, "exists");
    assert.deepEqual(moved.status === "exists" && moved.orgMismatch, {
      stored: "org_one",
      requested: "org_two",
    });
    assert.equal((await storage.apiKeys.getByHash(hashApiKey(BOOTSTRAP_KEY)))?.orgId, "org_one");
  } finally {
    await storage.close();
  }
});
