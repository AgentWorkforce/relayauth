import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { TokenVerifier } from "../verify.js";
import { RelayAuthError } from "../errors.js";

function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJsonBase64Url(obj: Record<string, unknown>): string {
  return base64UrlEncode(JSON.stringify(obj));
}

const validClaims = {
  sub: "identity-1",
  org: "org-1",
  wks: "wks-1",
  scopes: ["relay:agent:read"],
  sponsorId: "sponsor-1",
  sponsorChain: ["sponsor-1"],
  token_type: "access" as const,
  iss: "relayauth:test",
  aud: ["api.example.com"],
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000) - 60,
  jti: "token-id-1",
};

async function generateRS256KeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, jwk };
}

async function signToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<string> {
  const encodedHeader = encodeJsonBase64Url(header);
  const encodedPayload = encodeJsonBase64Url(payload);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    privateKey,
    signingInput,
  );
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function slowFetchHonoringSignal(delayMs: number, response: () => Response) {
  return mock.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => resolve(response()), delayMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          const reason =
            (signal as AbortSignal & { reason?: unknown }).reason ??
            new DOMException("The operation was aborted.", "AbortError");
          reject(reason);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  });
}

describe("TokenVerifier — fetch timeouts", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("aborts JWKS fetch after jwksTimeoutMs and throws within the window", async () => {
    const { privateKey } = await generateRS256KeyPair();
    const token = await signToken(
      { alg: "RS256", typ: "JWT", kid: "k1" },
      validClaims,
      privateKey,
    );

    // Slow fetch that would never resolve in test time if the abort signal is missing.
    globalThis.fetch = slowFetchHonoringSignal(60_000, () => new Response("never", { status: 200 }));

    const timeoutMs = 100;
    const verifier = new TokenVerifier({
      jwksUrl: "https://auth.test/.well-known/jwks.json",
      jwksTimeoutMs: timeoutMs,
    });

    const start = Date.now();
    await assert.rejects(
      async () => { await verifier.verify(token); },
      (err) => {
        assert.ok(err instanceof RelayAuthError, "expected RelayAuthError");
        assert.match((err as Error).message, /Failed to fetch JWKS/);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    // Should fire well before the 60s slow-fetch — give generous slack for CI jitter
    // but still prove we did not hang on the upstream.
    assert.ok(elapsed < 2000, `expected timeout to fire quickly, took ${elapsed}ms`);
    assert.ok(elapsed >= timeoutMs - 20, `expected to wait at least ~${timeoutMs}ms, took ${elapsed}ms`);
  });

  it("falls back to default JWKS timeout when jwksTimeoutMs is not provided", async () => {
    const { privateKey } = await generateRS256KeyPair();
    const token = await signToken(
      { alg: "RS256", typ: "JWT", kid: "k1" },
      validClaims,
      privateKey,
    );

    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = mock.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 }));
    });

    const verifier = new TokenVerifier({
      jwksUrl: "https://auth.test/.well-known/jwks.json",
    });

    await assert.rejects(async () => { await verifier.verify(token); });
    assert.ok(observedSignal, "expected fetch to be called with an AbortSignal");
  });

  it("aborts revocation fetch after revocationTimeoutMs", async () => {
    const { privateKey, jwk } = await generateRS256KeyPair();
    const kid = "rev-key-1";
    const jwkWithKid = { ...jwk, kid, use: "sig", alg: "RS256" };

    const token = await signToken(
      { alg: "RS256", typ: "JWT", kid },
      validClaims,
      privateKey,
    );

    globalThis.fetch = mock.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("jwks")) {
        return Promise.resolve(new Response(JSON.stringify({ keys: [jwkWithKid] }), { status: 200 }));
      }
      // Revocation: a slow response (60s) that holds a refed timer open. The
      // verifier's AbortSignal.timeout should fire well before, aborting the
      // request. The refed timer guarantees the event loop stays alive long
      // enough for the abort to land (AbortSignal.timeout uses an unref'd
      // timer, so without this the test process can exit early).
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => resolve(new Response("never", { status: 200 })), 60_000);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            const reason =
              (signal as AbortSignal & { reason?: unknown }).reason ??
              new DOMException("The operation was aborted.", "AbortError");
            reject(reason);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
    });

    const timeoutMs = 100;
    const verifier = new TokenVerifier({
      jwksUrl: "https://auth.test/.well-known/jwks.json",
      issuer: "relayauth:test",
      audience: ["api.example.com"],
      checkRevocation: true,
      revocationUrl: "https://auth.test/revocation",
      revocationTimeoutMs: timeoutMs,
    });

    const start = Date.now();
    await assert.rejects(
      async () => { await verifier.verify(token); },
      (err) => {
        assert.ok(err instanceof RelayAuthError);
        assert.match((err as Error).message, /Failed to check token revocation/);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected revocation timeout to fire quickly, took ${elapsed}ms`);
    assert.ok(elapsed >= timeoutMs - 20, `expected to wait at least ~${timeoutMs}ms, took ${elapsed}ms`);
  });
});
