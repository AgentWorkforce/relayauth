import type { RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError, TokenExpiredError } from "./errors.js";

export interface VerifyOptions {
  jwksUrl?: string;
  issuer?: string;
  audience?: string[];
  maxAge?: number;
}

export class TokenVerifier {
  readonly options?: VerifyOptions;

  constructor(options?: VerifyOptions) {
    this.options = options;
  }

  async verify(token: string, signingKey?: string): Promise<RelayAuthTokenClaims> {
    if (!signingKey) {
      throw new RelayAuthError("Signing key is required", "missing_signing_key", 500);
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw invalidTokenError();
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
    const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);

    if (!header || !payload || header.alg !== "HS256" || header.typ !== "JWT") {
      throw invalidTokenError();
    }

    const isValidSignature = await verifyHs256Signature(
      `${encodedHeader}.${encodedPayload}`,
      signature,
      signingKey,
    );

    if (!isValidSignature) {
      throw invalidTokenError();
    }

    validateClaims(payload, this.options);
    return payload;
  }

  async verifyOrNull(token: string, signingKey?: string): Promise<RelayAuthTokenClaims | null> {
    try {
      return await this.verify(token, signingKey);
    } catch {
      return null;
    }
  }
}

type JwtHeader = {
  alg?: string;
  typ?: string;
};

function invalidTokenError(): RelayAuthError {
  return new RelayAuthError("Invalid access token", "invalid_token", 401);
}

function validateClaims(claims: RelayAuthTokenClaims, options?: VerifyOptions): void {
  const now = Math.floor(Date.now() / 1000);

  if (
    typeof claims.sub !== "string" ||
    typeof claims.org !== "string" ||
    typeof claims.wks !== "string" ||
    typeof claims.sponsorId !== "string" ||
    !Array.isArray(claims.scopes) ||
    !Array.isArray(claims.sponsorChain) ||
    typeof claims.iss !== "string" ||
    !Array.isArray(claims.aud) ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    typeof claims.jti !== "string"
  ) {
    throw invalidTokenError();
  }

  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now)) {
    throw invalidTokenError();
  }

  if (claims.exp <= now) {
    throw new TokenExpiredError();
  }

  if (options?.issuer && claims.iss !== options.issuer) {
    throw invalidTokenError();
  }

  if (
    options?.audience &&
    !options.audience.some((audience) => claims.aud.includes(audience))
  ) {
    throw invalidTokenError();
  }

  if (options?.maxAge !== undefined && claims.iat + options.maxAge < now) {
    throw new TokenExpiredError();
  }
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

async function verifyHs256Signature(
  value: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64UrlToBytes(signature),
      new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

function decodeBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return bytes;
}
