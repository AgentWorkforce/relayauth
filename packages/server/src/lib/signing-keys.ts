import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem, type RsaPublicJwk } from "./jwk.js";
import { keyIdFromPublicJwk, pemToArrayBuffer } from "./sign-rs256.js";

/**
 * Multi-key RS256 signing configuration.
 *
 * Three key slots, each a PEM (PKCS#8 private key or SPKI public key):
 *
 * - current  — RELAYAUTH_SIGNING_KEY_PEM (private, signs everything) plus the
 *              optional RELAYAUTH_SIGNING_KEY_PEM_PUBLIC. When the public half
 *              is not bound it is derived from the private key.
 * - next     — RELAYAUTH_SIGNING_KEY_PEM_NEXT: published in the JWKS ahead of
 *              a rotation so verifiers cache it before anything is signed with
 *              it. Verify-only.
 * - previous — RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS: the key that signed before
 *              the last rotation, kept published until every token it signed
 *              has expired. Verify-only.
 *
 * `kid` is always the RFC 7638 thumbprint of the public key, so it is stable
 * across restarts and identical whether a slot holds the private or the public
 * half. Pure WebCrypto: this module must stay runtime-neutral (Node + Workers).
 */
export type SigningKeyEnv = Pick<
  AppConfig,
  | "RELAYAUTH_SIGNING_KEY_PEM"
  | "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC"
  | "RELAYAUTH_SIGNING_KEY_PEM_NEXT"
  | "RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS"
>;

export type SigningKeySlot = "current" | "next" | "previous";

export type PublishedSigningKey = {
  slot: SigningKeySlot;
  kid: string;
  jwk: RsaPublicJwk;
};

const JWK_CACHE_MAX = 32;
const jwkCache = new Map<string, Promise<RsaPublicJwk>>();

function isPrivateKeyPem(pem: string): boolean {
  return /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/u.test(pem);
}

async function derivePublicJwk(pem: string): Promise<RsaPublicJwk> {
  if (!isPrivateKeyPem(pem)) {
    const withoutKid = await rsaPublicJwkFromPem(pem, "");
    return { ...withoutKid, kid: await keyIdFromPublicJwk(withoutKid) };
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"],
  );
  const exported = await crypto.subtle.exportKey("jwk", privateKey);
  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("Invalid RSA private key: expected RSA modulus and exponent");
  }
  const jwk: RsaPublicJwk = {
    kty: "RSA",
    n: exported.n,
    e: exported.e,
    kid: "",
    use: "sig",
    alg: "RS256",
  };
  return { ...jwk, kid: await keyIdFromPublicJwk(jwk) };
}

/** Public JWK (with thumbprint kid) for a private or public PEM. Memoized per PEM. */
export function publicJwkFromAnyPem(pem: string): Promise<RsaPublicJwk> {
  const normalized = pem.trim();
  const cached = jwkCache.get(normalized);
  if (cached) {
    return cached;
  }
  const pending = derivePublicJwk(normalized);
  // Do not memoize failures: a misconfigured key should keep surfacing its error.
  pending.catch(() => jwkCache.delete(normalized));
  if (jwkCache.size >= JWK_CACHE_MAX) {
    const oldest = jwkCache.keys().next().value;
    if (oldest !== undefined) jwkCache.delete(oldest);
  }
  jwkCache.set(normalized, pending);
  return pending;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

/** The private PEM that signs new tokens, if configured. */
export function resolveCurrentPrivateKeyPem(env: SigningKeyEnv): string | undefined {
  return trimmed(env.RELAYAUTH_SIGNING_KEY_PEM);
}

/**
 * Public JWK of the current signing key: the explicit public PEM when bound,
 * otherwise derived from the private key. Undefined when neither is set.
 */
export async function resolveCurrentPublicJwk(
  env: SigningKeyEnv,
): Promise<RsaPublicJwk | undefined> {
  const publicPem = trimmed(env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC);
  if (publicPem) {
    return publicJwkFromAnyPem(publicPem);
  }
  const privatePem = resolveCurrentPrivateKeyPem(env);
  return privatePem ? publicJwkFromAnyPem(privatePem) : undefined;
}

/** Every key this issuer publishes (current, next, previous), deduplicated by kid. */
export async function resolvePublishedSigningKeys(
  env: SigningKeyEnv,
): Promise<PublishedSigningKey[]> {
  const slots: Array<[SigningKeySlot, Promise<RsaPublicJwk | undefined>]> = [
    ["current", resolveCurrentPublicJwk(env)],
    ["next", optionalJwk(env.RELAYAUTH_SIGNING_KEY_PEM_NEXT)],
    ["previous", optionalJwk(env.RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS)],
  ];

  const keys: PublishedSigningKey[] = [];
  const seen = new Set<string>();
  for (const [slot, pending] of slots) {
    const jwk = await pending;
    if (!jwk || seen.has(jwk.kid)) {
      continue;
    }
    seen.add(jwk.kid);
    keys.push({ slot, kid: jwk.kid, jwk });
  }
  return keys;
}

function optionalJwk(pem: string | undefined): Promise<RsaPublicJwk | undefined> {
  const value = trimmed(pem);
  return value ? publicJwkFromAnyPem(value) : Promise.resolve(undefined);
}
