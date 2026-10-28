import type { RelayAuthTokenClaims } from "@relayauth/types";
import { TokenVerifier, type VerifyOptions } from "@relayauth/sdk";
import type { AppConfig } from "../env.js";
import { unwrapRelayToken } from "./jwt.js";
import { resolvePublishedSigningKeys, type SigningKeyEnv } from "./signing-keys.js";

type VerifierEnv = Pick<AppConfig, "BASE_URL" | "RELAYAUTH_ISSUER"> & SigningKeyEnv;
type VerifyTokenOptions = Omit<VerifyOptions, "jwksUrl">;

export async function verifyRs256Token(
  token: string,
  env: VerifierEnv,
  options: VerifyTokenOptions = {},
): Promise<RelayAuthTokenClaims> {
  // When an operator sets RELAYAUTH_ISSUER, every RelayAuth-signed bearer must
  // carry it (bearer auth, scope middleware, audit), matching what refresh and
  // introspection already require. Unset keeps the historical behaviour of not
  // pinning `iss` on these paths, so hosted deployments see no change.
  const explicitIssuer = env.RELAYAUTH_ISSUER?.trim();
  const verifier = new TokenVerifier({
    // The relayauth server enforces revocation itself on every request via its
    // own fail-closed denylist (authenticateFromContext -> isBearerTokenInactive,
    // and the /introspect + /refresh routes). It does not use the SDK verifier's
    // HTTP revocation endpoint, so opt out of the forced indefinite-token check
    // here to avoid a spurious `revocation_required` on the issuer's own path.
    // External resource servers using the SDK verifier keep the forced check.
    revocationHandledExternally: true,
    ...(explicitIssuer ? { issuer: explicitIssuer } : {}),
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
  // All published keys (current, next, previous) are accepted, so tokens
  // signed before a rotation keep verifying while the previous key is bound.
  const published = await resolvePublishedSigningKeys(env);
  if (published.length > 0) {
    const jwks = { keys: published.map((key) => key.jwk) };
    return `data:application/json,${encodeURIComponent(JSON.stringify(jwks))}`;
  }

  const baseUrl = env.BASE_URL?.trim();
  if (baseUrl) {
    return new URL("/.well-known/jwks.json", baseUrl).toString();
  }

  return "http://127.0.0.1:8787/.well-known/jwks.json";
}
