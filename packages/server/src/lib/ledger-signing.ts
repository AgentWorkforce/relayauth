import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem } from "./jwk.js";
import { importRsaPrivateKey, keyIdFromPublicJwk, signCanonicalRs256 } from "./sign-rs256.js";

type LedgerSigningEnv = Pick<
  AppConfig,
  "RELAYAUTH_SIGNING_KEY_PEM" | "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC"
>;

export type LedgerSigningMaterial = { privateKey: CryptoKey; kid: string };

/**
 * Resolves the ledger signing key and kid once so a caller can reuse it
 * across many entries in one request instead of re-parsing the public PEM
 * into a JWK and re-importing the private key per entry.
 */
export async function resolveLedgerSigningMaterial(
  env: LedgerSigningEnv,
): Promise<LedgerSigningMaterial> {
  const privateKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM?.trim();
  if (!privateKeyPem) {
    throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set");
  }
  const publicKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  const kid = publicKeyPem
    ? await keyIdFromPublicJwk(await rsaPublicJwkFromPem(publicKeyPem, ""))
    : "rs256-key";
  const privateKey = await importRsaPrivateKey(privateKeyPem);
  return { privateKey, kid };
}

/** Sign a ledger payload (canonical JSON) with previously-resolved signing material. */
export function signLedgerPayload(
  material: LedgerSigningMaterial,
  payload: Record<string, unknown>,
): Promise<string> {
  return signCanonicalRs256(payload, material.privateKey, material.kid);
}
