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
import { resolvePublishedSigningKeys } from "../lib/signing-keys.js";
import { verifyRs256Token } from "../lib/token-verifier.js";
import { createApp, readEnvOrFile } from "../server.js";
import { createTestStorage } from "./test-helpers.js";

type KeyPair = { privatePem: string; publicPem: string };

function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
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
