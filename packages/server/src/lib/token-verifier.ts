import type { RelayAuthTokenClaims } from "@relayauth/types";
import { TokenVerifier, type VerifyOptions } from "@relayauth/sdk";
import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem } from "./jwk.js";
import { keyIdFromPublicJwk } from "./sign-rs256.js";

type VerifierEnv = Pick<AppConfig, "BASE_URL" | "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC">;
type VerifyTokenOptions = Omit<VerifyOptions, "jwksUrl">;

export async function verifyRs256Token(
  token: string,
  env: VerifierEnv,
  options: VerifyTokenOptions = {},
): Promise<RelayAuthTokenClaims> {
  const verifier = new TokenVerifier({
    ...options,
    jwksUrl: await resolveJwksUrl(env),
  });

  return verifier.verify(token);
}

async function resolveJwksUrl(env: VerifierEnv): Promise<string> {
  const baseUrl = env.BASE_URL?.trim();
  if (baseUrl) {
    return new URL("/.well-known/jwks.json", baseUrl).toString();
  }

  const publicKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  if (!publicKeyPem) {
    return "http://127.0.0.1:8787/.well-known/jwks.json";
  }

  const keyWithPlaceholderKid = await rsaPublicJwkFromPem(publicKeyPem, "");
  const jwks = {
    keys: [
      {
        ...keyWithPlaceholderKid,
        kid: await keyIdFromPublicJwk(keyWithPlaceholderKid),
      },
    ],
  };

  return `data:application/json,${encodeURIComponent(JSON.stringify(jwks))}`;
}
