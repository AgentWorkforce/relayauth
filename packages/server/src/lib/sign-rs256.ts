import type { RelayAuthTokenClaims } from "@relayauth/types";

const textEncoder = new TextEncoder();

const MIN_RSA_MODULUS_BITS = 2048;
const RECOMMENDED_RSA_MODULUS_BITS = 3072;

export type RsaThumbprintJwk = {
  kty: "RSA";
  n: string;
  e: string;
};

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const keyMaterial = pemToArrayBuffer(pem);
  const modulusBits = extractRsaModulusBitsFromPkcs8(keyMaterial);

  if (modulusBits !== undefined) {
    if (modulusBits < MIN_RSA_MODULUS_BITS) {
      throw new Error(
        `RSA private key modulus is ${modulusBits} bits; RelayAuth requires at least ${MIN_RSA_MODULUS_BITS} bits`,
      );
    }

    if (modulusBits < RECOMMENDED_RSA_MODULUS_BITS) {
      const logger = globalThis.console;
      logger?.warn?.(
        `RelayAuth: RSA private key modulus is ${modulusBits} bits; `
          + `specs/token-format.md recommends ${RECOMMENDED_RSA_MODULUS_BITS}-bit or larger for new deployments. `
          + "Legacy 2048-bit keys are permitted but must be sunset by 2028-01-01.",
      );
    }
  }

  return crypto.subtle.importKey(
    "pkcs8",
    keyMaterial,
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

/**
 * Compute the RFC 7638 JWK thumbprint (SHA-256, base64url) of an RSA public JWK.
 *
 * The thumbprint is derived from a canonical JSON form that contains the REQUIRED
 * members only (RFC 7638 §3.2) in lexicographic key order with no whitespace:
 *   {"e":"<base64url>","kty":"RSA","n":"<base64url>"}
 *
 * This is deterministic, independent of wall-clock time, and can be recomputed
 * by any downstream verifier from the published JWK alone — guaranteeing that
 * the `kid` on a signed token matches the `kid` on the JWK in the JWKS.
 */
export async function rfc7638Thumbprint(jwk: RsaThumbprintJwk): Promise<string> {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new Error("RFC 7638 thumbprint requires an RSA JWK with kty, n, and e");
  }

  // Lexicographic key order: e < kty < n.
  const canonical = `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonical));

  return encodeBytesAsBase64Url(digest);
}

/**
 * Derive the `kid` for an RSA public JWK as its RFC 7638 JWK thumbprint.
 *
 * Deterministic given the key material — independent of wall-clock time,
 * environment, or process lifetime. This guarantees the signer's `kid`
 * matches the JWKS `kid` across process restarts and month boundaries.
 */
export async function keyIdFromPublicJwk(jwk: JsonWebKey): Promise<string> {
  const { kty, n, e } = jwk as { kty?: unknown; n?: unknown; e?: unknown };
  if (kty !== "RSA" || typeof n !== "string" || typeof e !== "string") {
    throw new Error("RSA public JWK must include kty=RSA plus n and e");
  }

  return rfc7638Thumbprint({ kty: "RSA", n, e });
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

/**
 * Parse a PKCS#8-encoded RSA private key and return its modulus length in bits.
 *
 * Structure traversed (PKCS#8 RFC 5208 → PKCS#1 RFC 3447):
 *   PrivateKeyInfo ::= SEQUENCE {
 *     version,
 *     privateKeyAlgorithm AlgorithmIdentifier,
 *     privateKey OCTET STRING (containing RSAPrivateKey)
 *   }
 *   RSAPrivateKey ::= SEQUENCE { version, modulus INTEGER, ... }
 *
 * Returns `undefined` on any parse failure so that the caller falls back to
 * WebCrypto's own validation rather than rejecting a structurally valid key
 * that we merely failed to inspect.
 */
function extractRsaModulusBitsFromPkcs8(keyMaterial: ArrayBuffer): number | undefined {
  try {
    const view = new Uint8Array(keyMaterial);
    const outer = readSequence(view, 0);
    if (!outer) return undefined;
    // Skip version INTEGER.
    const versionEnd = skipTlv(view, outer.contentStart);
    if (versionEnd === undefined) return undefined;
    // Skip AlgorithmIdentifier SEQUENCE.
    const algEnd = skipTlv(view, versionEnd);
    if (algEnd === undefined) return undefined;
    // privateKey OCTET STRING.
    if (view[algEnd] !== 0x04) return undefined;
    const octetLen = readLength(view, algEnd + 1);
    if (!octetLen) return undefined;
    const rsaPrivateKeyStart = octetLen.contentStart;
    // Inner SEQUENCE (RSAPrivateKey).
    const inner = readSequence(view, rsaPrivateKeyStart);
    if (!inner) return undefined;
    // Skip version INTEGER.
    const innerVersionEnd = skipTlv(view, inner.contentStart);
    if (innerVersionEnd === undefined) return undefined;
    // modulus INTEGER.
    if (view[innerVersionEnd] !== 0x02) return undefined;
    const modLen = readLength(view, innerVersionEnd + 1);
    if (!modLen) return undefined;

    let modulusBytes = modLen.contentLength;
    // DER encodes positive INTEGERs with a leading 0x00 when the MSB is set,
    // so strip that padding before computing bit length.
    if (modulusBytes > 0 && view[modLen.contentStart] === 0x00) {
      modulusBytes -= 1;
    }

    return modulusBytes * 8;
  } catch {
    return undefined;
  }
}

function readSequence(
  view: Uint8Array,
  offset: number,
): { contentStart: number; contentLength: number } | undefined {
  if (view[offset] !== 0x30) return undefined;
  return readLength(view, offset + 1);
}

function readLength(
  view: Uint8Array,
  offset: number,
): { contentStart: number; contentLength: number } | undefined {
  if (offset >= view.length) return undefined;
  const first = view[offset];
  if (first < 0x80) {
    return { contentStart: offset + 1, contentLength: first };
  }
  const lenBytes = first & 0x7f;
  if (lenBytes === 0 || lenBytes > 4 || offset + 1 + lenBytes > view.length) return undefined;
  let length = 0;
  for (let i = 0; i < lenBytes; i++) {
    length = (length << 8) | view[offset + 1 + i];
  }
  return { contentStart: offset + 1 + lenBytes, contentLength: length };
}

function skipTlv(view: Uint8Array, offset: number): number | undefined {
  if (offset >= view.length) return undefined;
  const len = readLength(view, offset + 1);
  if (!len) return undefined;
  return len.contentStart + len.contentLength;
}
