import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { authenticateBearerOrApiKey } from "../lib/auth.js";

export function apiKeyAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const apiKey = c.req.header("x-api-key");
    if (!apiKey) {
      return next();
    }

    const auth = await authenticateBearerOrApiKey(
      c.req.header("authorization"),
      apiKey,
      c.env.SIGNING_KEY,
      c.get("storage"),
    );
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }

    if (auth.via === "api_key") {
      c.req.raw.headers.set(
        "authorization",
        `Bearer ${await signHs256Token(auth.claims, c.env.SIGNING_KEY)}`,
      );
    }

    await next();
  };
}

async function signHs256Token(claims: RelayAuthTokenClaims, signingKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(claims));
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(unsigned),
  );

  return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
