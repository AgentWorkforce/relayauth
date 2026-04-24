import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem } from "./jwk.js";
import { keyIdFromPublicJwk, signRs256 } from "./sign-rs256.js";

type SigningEnv = Pick<
  AppConfig,
  "RELAYAUTH_SIGNING_KEY_PEM" | "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC"
>;

export async function signToken(claims: RelayAuthTokenClaims, env: SigningEnv): Promise<string> {
  const privateKeyPem = resolveRs256PrivateKeyPem(env);
  if (!privateKeyPem) {
    throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set");
  }

  const kid = await resolveRs256KeyId(env);
  return signRs256(claims, privateKeyPem, kid);
}

async function resolveRs256KeyId(env: SigningEnv): Promise<string> {
  const publicKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  if (publicKeyPem) {
    const jwk = await rsaPublicJwkFromPem(publicKeyPem, "");
    return keyIdFromPublicJwk(jwk);
  }

  return "rs256-key";
}

function resolveRs256PrivateKeyPem(env: SigningEnv): string | undefined {
  const configuredPem = env.RELAYAUTH_SIGNING_KEY_PEM?.trim();
  if (configuredPem) {
    return configuredPem;
  }

  return globalThis.process?.env?.RELAYAUTH_SIGNING_KEY_PEM?.trim();
}
