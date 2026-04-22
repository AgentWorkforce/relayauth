import type { RelayAuthTokenClaims } from "@relayauth/types";

type RsaPublicJwkFingerprintInput = Pick<JsonWebKey, "kty" | "n" | "e">;

const textEncoder = new TextEncoder();

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

export async function signRs256(
  claims: RelayAuthTokenClaims,
  key: CryptoKey | string,
  kid: string,
): Promise<string> {
  const privateKey = typeof key === "string" ? await importRsaPrivateKey(key) : key;
  const encodedHeader = encodeJsonAsBase64Url({
    alg: "RS256",
    typ: "JWT",
    kid,
  });
  const encodedPayload = encodeJsonAsBase64Url(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    {
      name: "RSASSA-PKCS1-v1_5",
    },
    privateKey,
    textEncoder.encode(signingInput),
  );

  return `${signingInput}.${encodeBytesAsBase64Url(signature)}`;
}

export async function keyIdFromPublicJwk(jwk: JsonWebKey): Promise<string> {
  const fingerprint = canonicalizeRsaPublicJwk(jwk);
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(fingerprint));
  const hash8 = bytesToHex(new Uint8Array(digest)).slice(0, 8);
  const yearMonth = new Date().toISOString().slice(0, 7);

  return `${resolveEnvironmentStage()}-${yearMonth}-${hash8}`;
}

export function encodeJsonAsBase64Url(value: unknown): string {
  return encodeBytesAsBase64Url(textEncoder.encode(JSON.stringify(value)));
}

export function encodeBytesAsBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem.replace(/-----BEGIN [^-]+-----/gu, "")
    .replace(/-----END [^-]+-----/gu, "")
    .replace(/\s+/gu, "");

  if (!normalized) {
    throw new Error("Invalid PEM: no key material found");
  }

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function canonicalizeRsaPublicJwk(jwk: JsonWebKey): string {
  const { kty, n, e } = jwk as RsaPublicJwkFingerprintInput;
  if (kty !== "RSA" || typeof n !== "string" || typeof e !== "string") {
    throw new Error("RSA public JWK must include kty=RSA plus n and e");
  }

  return JSON.stringify({ e, kty, n });
}

function resolveEnvironmentStage(): string {
  const processEnv = globalThis.process?.env;
  const rawStage = processEnv?.RELAYAUTH_ENV_STAGE
    ?? processEnv?.RELAYAUTH_STAGE
    ?? processEnv?.NODE_ENV
    ?? "development";
  const normalizedStage = rawStage.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

  return normalizedStage || "development";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
