import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem, type RsaPublicJwk } from "./jwk.js";
import { keyIdFromPublicJwk, pemToArrayBuffer } from "./sign-rs256.js";

/**
 * Multi-key RS256 signing configuration.
 *
 * Three key slots, each a PEM (PKCS#8 private key or SPKI public key):
 *
 * - current  — RELAYAUTH_SIGNING_KEY_PEM (PKCS#8 private, signs everything).
 *              Its public half is always derived from it; the optional
 *              RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is only a cross-check and a
 *              mismatch is a fatal configuration error.
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

/** A signing-key configuration the server must refuse to run with. */
export class SigningKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyConfigError";
  }
}

type PemKind = "pkcs8" | "spki" | "unlabelled";

/**
 * Classify a PEM by its armor label. Only unencrypted PKCS#8 ("PRIVATE KEY")
 * and SPKI ("PUBLIC KEY") are supported; PKCS#1 ("RSA PRIVATE KEY" /
 * "RSA PUBLIC KEY") and encrypted PKCS#8 get an actionable error instead of
 * an opaque WebCrypto import failure. Unlabelled base64 DER is tolerated for
 * back-compat with deployments that store the bare key body.
 */
function classifyPem(pem: string, name: string): PemKind {
  const labels = [...pem.matchAll(/-----BEGIN ([^-]+)-----/gu)].map((match) => match[1]);
  if (labels.length === 0) return "unlabelled";
  if (labels.length > 1) {
    throw new SigningKeyConfigError(`${name} must contain exactly one PEM block`);
  }
  const label = labels[0];
  if (label === "PRIVATE KEY") return "pkcs8";
  if (label === "PUBLIC KEY") return "spki";
  if (label === "RSA PRIVATE KEY") {
    throw new SigningKeyConfigError(
      `${name} is a PKCS#1 key (BEGIN RSA PRIVATE KEY); convert it to PKCS#8 with `
        + "`openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem`",
    );
  }
  if (label === "ENCRYPTED PRIVATE KEY") {
    throw new SigningKeyConfigError(
      `${name} is an encrypted PKCS#8 key; RelayAuth needs an unencrypted PKCS#8 key `
        + "(BEGIN PRIVATE KEY): `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem`",
    );
  }
  if (label === "RSA PUBLIC KEY") {
    throw new SigningKeyConfigError(
      `${name} is a PKCS#1 public key (BEGIN RSA PUBLIC KEY); export it as SPKI with `
        + "`openssl rsa -in key.pem -pubout`",
    );
  }
  throw new SigningKeyConfigError(
    `${name} has unsupported PEM type "${label}"; expected BEGIN PRIVATE KEY (PKCS#8) or BEGIN PUBLIC KEY (SPKI)`,
  );
}

async function derivePublicJwk(pem: string, asPrivate: boolean): Promise<RsaPublicJwk> {
  if (!asPrivate) {
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

function cachedJwk(pem: string, asPrivate: boolean): Promise<RsaPublicJwk> {
  const cacheKey = `${asPrivate ? "pkcs8" : "spki"}:${pem}`;
  const cached = jwkCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = derivePublicJwk(pem, asPrivate);
  // Do not memoize failures: a misconfigured key should keep surfacing its error.
  pending.catch(() => jwkCache.delete(cacheKey));
  if (jwkCache.size >= JWK_CACHE_MAX) {
    const oldest = jwkCache.keys().next().value;
    if (oldest !== undefined) jwkCache.delete(oldest);
  }
  jwkCache.set(cacheKey, pending);
  return pending;
}

/**
 * Public JWK (with thumbprint kid) for a PKCS#8 private or SPKI public PEM.
 * Memoized per PEM. Unlabelled key bodies are read as SPKI.
 */
export function publicJwkFromAnyPem(
  pem: string,
  name = "signing key",
): Promise<RsaPublicJwk> {
  const normalized = pem.trim();
  try {
    return cachedJwk(normalized, classifyPem(normalized, name) === "pkcs8");
  } catch (error) {
    return Promise.reject(error);
  }
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
 * Public JWK of the current signing key. When the private key is configured
 * the public half is always derived from it, so the advertised kid can never
 * drift from the key that actually signs. An explicit
 * RELAYAUTH_SIGNING_KEY_PEM_PUBLIC is then only a cross-check: if it names a
 * different key (e.g. left stale after a rotation) this throws a
 * SigningKeyConfigError instead of signing with one key while advertising
 * another. With no private key, the explicit public key is published as-is
 * (verify-only). Undefined when neither is set.
 */
export async function resolveCurrentPublicJwk(
  env: SigningKeyEnv,
): Promise<RsaPublicJwk | undefined> {
  const privatePem = resolveCurrentPrivateKeyPem(env);
  const publicPem = trimmed(env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC);
  if (!privatePem) {
    return publicPem
      ? publicJwkFromAnyPem(publicPem, "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC")
      : undefined;
  }

  const privateKind = classifyPem(privatePem, "RELAYAUTH_SIGNING_KEY_PEM");
  if (privateKind === "spki") {
    throw new SigningKeyConfigError(
      "RELAYAUTH_SIGNING_KEY_PEM must be a PKCS#8 private key (BEGIN PRIVATE KEY), not a public key",
    );
  }
  // An unlabelled body in the signing slot is the PKCS#8 DER (it is imported
  // as pkcs8 to sign), so derive from it as a private key.
  const derived = await cachedJwk(privatePem, true);
  if (publicPem) {
    const explicit = await publicJwkFromAnyPem(publicPem, "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC");
    if (explicit.kid !== derived.kid) {
      throw new SigningKeyConfigError(
        "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC does not match RELAYAUTH_SIGNING_KEY_PEM "
          + `(public kid ${explicit.kid}, private key kid ${derived.kid}). `
          + "Unset RELAYAUTH_SIGNING_KEY_PEM_PUBLIC (it is derived from the private key) "
          + "or update it together with the private key.",
      );
    }
  }
  return derived;
}

/**
 * Validate every configured signing-key slot. Call at boot so a bad key
 * (wrong format, mismatched public half) stops the server instead of failing
 * on the first token request.
 */
export async function assertSigningKeyConfig(env: SigningKeyEnv): Promise<PublishedSigningKey[]> {
  return resolvePublishedSigningKeys(env);
}

/** Every key this issuer publishes (current, next, previous), deduplicated by kid. */
export async function resolvePublishedSigningKeys(
  env: SigningKeyEnv,
): Promise<PublishedSigningKey[]> {
  // Promise.all so a failing slot never leaves another slot's rejection unhandled.
  const resolved = await Promise.all([
    resolveCurrentPublicJwk(env),
    optionalJwk(env.RELAYAUTH_SIGNING_KEY_PEM_NEXT, "RELAYAUTH_SIGNING_KEY_PEM_NEXT"),
    optionalJwk(env.RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS, "RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS"),
  ]);
  const slots: SigningKeySlot[] = ["current", "next", "previous"];

  const keys: PublishedSigningKey[] = [];
  const seen = new Set<string>();
  for (const [index, slot] of slots.entries()) {
    const jwk = resolved[index];
    if (!jwk || seen.has(jwk.kid)) {
      continue;
    }
    seen.add(jwk.kid);
    keys.push({ slot, kid: jwk.kid, jwk });
  }
  return keys;
}

function optionalJwk(
  pem: string | undefined,
  name: string,
): Promise<RsaPublicJwk | undefined> {
  const value = trimmed(pem);
  return value ? publicJwkFromAnyPem(value, name) : Promise.resolve(undefined);
}
