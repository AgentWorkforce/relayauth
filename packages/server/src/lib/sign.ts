import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { AppConfig } from "../env.js";
import { rsaPublicJwkFromPem } from "./jwk.js";
import {
  encodeBytesAsBase64Url,
  encodeJsonAsBase64Url,
  keyIdFromPublicJwk,
  signRs256,
} from "./sign-rs256.js";

type SigningEnv = Pick<
  AppConfig,
  | "SIGNING_KEY"
  | "SIGNING_KEY_ID"
  | "RELAYAUTH_SIGNING_ALG"
  | "RELAYAUTH_SIGNING_KEY_PEM"
  | "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC"
>;

const textEncoder = new TextEncoder();

export async function signToken(claims: RelayAuthTokenClaims, env: SigningEnv): Promise<string> {
  const algorithm = normalizeSigningAlgorithm(env.RELAYAUTH_SIGNING_ALG);

  if (algorithm === "RS256") {
    const privateKeyPem = resolveRs256PrivateKeyPem(env);
    if (!privateKeyPem) {
      throw new Error("RELAYAUTH_SIGNING_KEY_PEM must be set when RELAYAUTH_SIGNING_ALG=RS256");
    }

    const kid = await resolveRs256KeyId(env);
    return signRs256(claims, privateKeyPem, kid);
  }

  return signHs256(claims, env);
}

async function signHs256(claims: RelayAuthTokenClaims, env: SigningEnv): Promise<string> {
  const signingKey = env.SIGNING_KEY?.trim();
  if (!signingKey) {
    throw new Error("SIGNING_KEY must be set when RELAYAUTH_SIGNING_ALG=HS256");
  }

  const encodedHeader = encodeJsonAsBase64Url({
    alg: "HS256",
    typ: "JWT",
    kid: env.SIGNING_KEY_ID,
  });
  const encodedPayload = encodeJsonAsBase64Url(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(signingKey),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput));

  return `${signingInput}.${encodeBytesAsBase64Url(signature)}`;
}

async function resolveRs256KeyId(env: SigningEnv): Promise<string> {
  const publicKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  if (publicKeyPem) {
    const jwk = await rsaPublicJwkFromPem(publicKeyPem, "");
    return keyIdFromPublicJwk(jwk);
  }

  return env.SIGNING_KEY_ID?.trim() || "rs256-key";
}

function resolveRs256PrivateKeyPem(env: SigningEnv): string | undefined {
  const configuredPem = env.RELAYAUTH_SIGNING_KEY_PEM?.trim();
  if (configuredPem) {
    return configuredPem;
  }

  return globalThis.process?.env?.RELAYAUTH_SIGNING_KEY_PEM?.trim();
}

function normalizeSigningAlgorithm(value: string | undefined): "HS256" | "RS256" {
  const normalized = value?.trim().toUpperCase() || "HS256";
  if (normalized === "HS256" || normalized === "RS256") {
    return normalized;
  }

  throw new Error(`Unsupported signing algorithm: ${value}`);
}
