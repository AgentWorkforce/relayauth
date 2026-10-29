import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { AppConfig } from "../env.js";
import { signRs256 } from "./sign-rs256.js";
import {
  resolveCurrentPrivateKeyPem,
  resolveCurrentPublicJwk,
  type SigningKeyEnv,
} from "./signing-keys.js";

export const DEFAULT_ISSUER = "https://relayauth.dev";

/** The configured token issuer (`RELAYAUTH_ISSUER`), defaulting to https://relayauth.dev. */
export function resolveIssuer(env: Pick<AppConfig, "RELAYAUTH_ISSUER"> | undefined): string {
  return env?.RELAYAUTH_ISSUER?.trim() || DEFAULT_ISSUER;
}

export async function signToken(claims: RelayAuthTokenClaims, env: SigningKeyEnv): Promise<string> {
  const privateKeyPem = resolveCurrentPrivateKeyPem(env)
    ?? globalThis.process?.env?.RELAYAUTH_SIGNING_KEY_PEM?.trim();
  if (!privateKeyPem) {
    throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set");
  }

  // kid is the RFC 7638 thumbprint of the current public key (explicit or
  // derived from the private key), so it always matches the JWKS entry.
  const publicJwk = await resolveCurrentPublicJwk({
    ...env,
    RELAYAUTH_SIGNING_KEY_PEM: privateKeyPem,
  });
  if (!publicJwk) {
    throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set");
  }
  return signRs256(claims, privateKeyPem, publicJwk.kid);
}
