import type { RelayAuthTokenClaims } from "@relayauth/types";

import { decodeBase64UrlJson, verifyHs256Signature } from "./jwt.js";

type JwtHeader = {
  alg?: string;
  typ?: string;
};

export async function authenticate(
  authorization: string | undefined,
  signingKey: string,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code: string; status: 401 }
> {
  if (!authorization) {
    return { ok: false, error: "Missing Authorization header", code: "missing_authorization", status: 401 };
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return { ok: false, error: "Invalid Authorization header", code: "invalid_authorization", status: 401 };
  }

  const claims = await verifyToken(token, signingKey);
  if (!claims) {
    return { ok: false, error: "Invalid access token", code: "invalid_token", status: 401 };
  }

  return { ok: true, claims };
}

export async function authenticateAndAuthorize(
  authorization: string | undefined,
  signingKey: string,
  requiredScope: string,
  matchScopeFn: (required: string, granted: string[]) => boolean,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string; code: string; status: 401 | 403 }
> {
  const auth = await authenticate(authorization, signingKey);
  if (!auth.ok) {
    return auth;
  }

  try {
    if (!matchScopeFn(requiredScope, auth.claims.scopes)) {
      return { ok: false, error: "insufficient_scope", code: "insufficient_scope", status: 403 };
    }
  } catch {
    return { ok: false, error: "insufficient_scope", code: "insufficient_scope", status: 403 };
  }

  return auth;
}

async function verifyToken(token: string, signingKey: string): Promise<RelayAuthTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !payload || header.alg !== "HS256") {
    return null;
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return null;
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.org !== "string" ||
    typeof payload.wks !== "string" ||
    typeof payload.sponsorId !== "string" ||
    !Array.isArray(payload.sponsorChain) ||
    !Array.isArray(payload.scopes)
  ) {
    return null;
  }

  return payload;
}

export { decodeBase64UrlJson } from "./jwt.js";
