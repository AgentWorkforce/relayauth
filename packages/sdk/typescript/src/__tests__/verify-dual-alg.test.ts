import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError } from "../errors.js";
import { TokenVerifier } from "../verify.js";

type SigningFixture = {
  kid: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
};

type Hs256Fixture = {
  kid: string;
  secret: Uint8Array;
  jwk: JsonWebKey;
};

const jwksUrl = "https://relay.example.test/.well-known/jwks.json";
const originalFetch = globalThis.fetch;
const originalAcceptHs256Env = process.env.RELAYAUTH_VERIFIER_ACCEPT_HS256;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAcceptHs256Env === undefined) {
    delete process.env.RELAYAUTH_VERIFIER_ACCEPT_HS256;
  } else {
    process.env.RELAYAUTH_VERIFIER_ACCEPT_HS256 = originalAcceptHs256Env;
  }
});

function createClaims(
  overrides: Partial<RelayAuthTokenClaims> = {},
): RelayAuthTokenClaims {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    sub: "agent_dual_alg",
    org: "org_dual_alg",
    wks: "ws_dual_alg",
    scopes: ["specialist:invoke"],
    sponsorId: "user_dual_alg",
    sponsorChain: ["user_dual_alg", "agent_dual_alg"],
    token_type: "access",
    iss: "https://relayauth.dev",
    aud: ["specialist"],
    exp: nowSeconds + 3600,
    iat: nowSeconds - 60,
    jti: "tok_dual_alg",
    ...overrides,
  };
}

async function createRs256Fixture(kid: string): Promise<SigningFixture> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey) as JsonWebKey & {
    alg?: string;
    kid?: string;
    use?: string;
  };

  publicJwk.alg = "RS256";
  publicJwk.kid = kid;
  publicJwk.use = "sig";

  return {
    kid,
    publicJwk,
    privateKey,
  };
}

function createHs256Fixture(kid: string): Hs256Fixture {
  const secret = crypto.getRandomValues(new Uint8Array(32));

  return {
    kid,
    secret,
    jwk: {
      kty: "oct",
      alg: "HS256",
      kid,
      use: "sig",
      k: Buffer.from(secret).toString("base64url"),
    },
  };
}

function encodeBase64Url(value: string | Buffer | Uint8Array | ArrayBuffer): string {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8").toString("base64url");
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value)).toString("base64url");
  }

  return Buffer.from(value).toString("base64url");
}

async function signJwt(
  header: Record<string, unknown>,
  claims: RelayAuthTokenClaims,
  key: CryptoKey | Uint8Array,
): Promise<string> {
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const data = new TextEncoder().encode(signingInput);

  let signature: ArrayBuffer;
  switch (header.alg) {
    case "RS256":
      signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key as CryptoKey,
        data,
      );
      break;
    case "HS256": {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key as Uint8Array,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
      break;
    }
    case "none":
      return `${encodedHeader}.${encodedPayload}.`;
    default:
      throw new Error(`Unsupported signing algorithm in test fixture: ${String(header.alg)}`);
  }

  return `${signingInput}.${encodeBase64Url(signature)}`;
}

function mutatePayload(token: string, nextClaims: RelayAuthTokenClaims): string {
  const [encodedHeader, , signature] = token.split(".");
  return `${encodedHeader}.${encodeBase64Url(JSON.stringify(nextClaims))}.${signature}`;
}

function mockJwks(keys: JsonWebKey[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), jwksUrl);
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof globalThis.fetch;
}

function createVerifier(): TokenVerifier {
  return new TokenVerifier({
    jwksUrl,
    issuer: "https://relayauth.dev",
    audience: ["specialist"],
  });
}

async function assertRejectsInvalidToken(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof RelayAuthError);
    assert.equal(error.code, "invalid_token");
    return true;
  });
}

test("verifies an RS256 token when the matching RSA JWK is published", async () => {
  const fixture = await createRs256Fixture("kid-rs256-primary");
  const claims = createClaims();
  const token = await signJwt(
    { alg: "RS256", typ: "JWT", kid: fixture.kid },
    claims,
    fixture.privateKey,
  );

  mockJwks([fixture.publicJwk]);

  const verified = await createVerifier().verify(token);

  assert.deepEqual(verified, claims);
});

test("also verifies an HS256 token during dual-accept when JWKS publishes both RSA and oct keys", async () => {
  const rs256Fixture = await createRs256Fixture("kid-rs256-dual-window");
  const hs256Fixture = createHs256Fixture("kid-hs256-dual-window");
  const claims = createClaims({ jti: "tok_dual_alg_hs256" });
  const token = await signJwt(
    { alg: "HS256", typ: "JWT", kid: hs256Fixture.kid },
    claims,
    hs256Fixture.secret,
  );

  mockJwks([rs256Fixture.publicJwk, hs256Fixture.jwk]);

  const verified = await createVerifier().verify(token);

  assert.deepEqual(verified, claims);
});

test("rejects an alg-confusion token when header.alg is HS256 but the matching kid resolves to an RSA JWK", async () => {
  const fixture = await createRs256Fixture("kid-confusion");
  const claims = createClaims({ jti: "tok_alg_confusion" });
  const token = await signJwt(
    { alg: "HS256", typ: "JWT", kid: fixture.kid },
    claims,
    crypto.getRandomValues(new Uint8Array(32)),
  );

  mockJwks([fixture.publicJwk]);

  await assertRejectsInvalidToken(() => createVerifier().verify(token));
});

test("rejects downgrade attacks that claim alg=none", async () => {
  const fixture = await createRs256Fixture("kid-none-downgrade");
  const claims = createClaims({ jti: "tok_none_downgrade" });
  const token = await signJwt(
    { alg: "none", typ: "JWT", kid: fixture.kid },
    claims,
    fixture.privateKey,
  );

  mockJwks([fixture.publicJwk]);

  await assertRejectsInvalidToken(() => createVerifier().verify(token));
});

test("rejects RS256 payload tampering after a valid token has been minted", async () => {
  const fixture = await createRs256Fixture("kid-rs256-tamper");
  const token = await signJwt(
    { alg: "RS256", typ: "JWT", kid: fixture.kid },
    createClaims({ jti: "tok_rs256_tamper", scopes: ["specialist:invoke"] }),
    fixture.privateKey,
  );

  mockJwks([fixture.publicJwk]);
  await createVerifier().verify(token);

  const tamperedToken = mutatePayload(
    token,
    createClaims({ jti: "tok_rs256_tamper", scopes: ["specialist:admin"] }),
  );

  await assertRejectsInvalidToken(() => createVerifier().verify(tamperedToken));
});

test("rejects HS256 payload tampering after a valid token has been minted", async () => {
  const rs256Fixture = await createRs256Fixture("kid-rs256-unused");
  const hs256Fixture = createHs256Fixture("kid-hs256-tamper");
  const token = await signJwt(
    { alg: "HS256", typ: "JWT", kid: hs256Fixture.kid },
    createClaims({ jti: "tok_hs256_tamper", scopes: ["specialist:invoke"] }),
    hs256Fixture.secret,
  );

  mockJwks([rs256Fixture.publicJwk, hs256Fixture.jwk]);
  await createVerifier().verify(token);

  const tamperedToken = mutatePayload(
    token,
    createClaims({ jti: "tok_hs256_tamper", scopes: ["specialist:admin"] }),
  );

  await assertRejectsInvalidToken(() => createVerifier().verify(tamperedToken));
});

test("rejects tokens whose header kid is not present in JWKS", async () => {
  const fixture = await createRs256Fixture("kid-present");
  const token = await signJwt(
    { alg: "RS256", typ: "JWT", kid: "kid-missing" },
    createClaims({ jti: "tok_missing_kid" }),
    fixture.privateKey,
  );

  mockJwks([fixture.publicJwk]);

  await assertRejectsInvalidToken(() => createVerifier().verify(token));
});

test("rejects HS256 tokens after the sunset flag disables legacy acceptance", async () => {
  const rs256Fixture = await createRs256Fixture("kid-rs256-sunset");
  const hs256Fixture = createHs256Fixture("kid-hs256-sunset");
  const claims = createClaims({ jti: "tok_hs256_sunset" });
  const token = await signJwt(
    { alg: "HS256", typ: "JWT", kid: hs256Fixture.kid },
    claims,
    hs256Fixture.secret,
  );

  mockJwks([rs256Fixture.publicJwk, hs256Fixture.jwk]);

  process.env.RELAYAUTH_VERIFIER_ACCEPT_HS256 = "true";
  const verifier = createVerifier();
  const verified = await verifier.verify(token);
  assert.deepEqual(verified, claims);

  process.env.RELAYAUTH_VERIFIER_ACCEPT_HS256 = "false";

  await assertRejectsInvalidToken(() => createVerifier().verify(token));
});
