import { importRsaPrivateKey, signCanonicalRs256 } from "./sign-rs256.js";
import {
  resolveCurrentPrivateKeyPem,
  resolveCurrentPublicJwk,
  type SigningKeyEnv,
} from "./signing-keys.js";

type LedgerSigningEnv = SigningKeyEnv;

export type LedgerSigningMaterial = { privateKey: CryptoKey; kid: string };

/**
 * Resolves the ledger signing key and kid once so a caller can reuse it
 * across many entries in one request instead of re-parsing the public PEM
 * into a JWK and re-importing the private key per entry.
 *
 * The kid is the RFC 7638 thumbprint of the current public key (explicit, or
 * derived from the private key), which is always published in the JWKS — so
 * an append-only ledger row never carries a kid verifiers cannot resolve.
 */
export async function resolveLedgerSigningMaterial(
  env: LedgerSigningEnv,
): Promise<LedgerSigningMaterial> {
  const privateKeyPem = resolveCurrentPrivateKeyPem(env);
  if (!privateKeyPem) {
    throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set");
  }
  const publicJwk = await resolveCurrentPublicJwk(env);
  if (!publicJwk) {
    throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set");
  }
  const privateKey = await importRsaPrivateKey(privateKeyPem);
  return { privateKey, kid: publicJwk.kid };
}

/** Sign a ledger payload (canonical JSON) with previously-resolved signing material. */
export function signLedgerPayload(
  material: LedgerSigningMaterial,
  payload: Record<string, unknown>,
): Promise<string> {
  return signCanonicalRs256(payload, material.privateKey, material.kid);
}
