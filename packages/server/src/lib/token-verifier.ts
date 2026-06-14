import type { RelayAuthTokenClaims } from "@relayauth/types";
import { TokenVerifier, type VerifyOptions } from "@relayauth/sdk";
import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem } from "./jwk.js";
import { unwrapRelayToken } from "./jwt.js";
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

  return verifier.verify(unwrapRelayToken(token));
}

async function resolveJwksUrl(env: VerifierEnv): Promise<string> {
  // Prefer building the JWKS inline from the locally-bound signing public key.
  // The worker already holds its own public key, so it never needs a network
  // sub-request — and on Cloudflare, fetching BASE_URL means the worker fetching
  // its OWN custom domain (api.relayauth.dev), a self-subrequest that fails and
  // throws "Failed to fetch JWKS", breaking ALL RS256 bearer verification
  // (e.g. the admin-bearer api-key mint -> 401 invalid_token). Only fall back to
  // a network fetch when no public key is bound (e.g. local/dev).
  const publicKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  if (publicKeyPem) {
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

  const baseUrl = env.BASE_URL?.trim();
  if (baseUrl) {
    return new URL("/.well-known/jwks.json", baseUrl).toString();
  }

  return "http://127.0.0.1:8787/.well-known/jwks.json";
}
