import type { JWKSResponse, RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError, TokenExpiredError, TokenRevokedError } from "./errors.js";
import { ScopeChecker } from "./scopes.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export interface VerifyOptions {
  jwksUrl?: string;
  issuer?: string;
  audience?: string[];
  maxAge?: number;
  cacheTtlMs?: number;
  checkRevocation?: boolean;
  revocationUrl?: string;
}

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type ParsedToken = {
  encodedHeader: string;
  encodedPayload: string;
  header: JwtHeader;
  payload: RelayAuthTokenClaims;
  signature: string;
};

type CachedJwks = {
  expiresAt: number;
  keys: JsonWebKey[];
};

type VerifierJwk = JsonWebKey & {
  alg?: string;
  crv?: string;
  kid?: string;
  use?: string;
};

export class TokenVerifier {
  readonly options?: VerifyOptions;

  #jwksCache?: CachedJwks;

  constructor(options?: VerifyOptions) {
    this.options = options;
  }

  async verify(token: string): Promise<RelayAuthTokenClaims> {
    const { encodedHeader, encodedPayload, header, payload, signature } = this.#parseToken(token);

    if (header.typ !== "JWT" || !isSupportedAlgorithm(header.alg)) {
      throw invalidTokenError();
    }

    const jwk = await this._findKey(header.kid, header.alg);
    const key = await importVerificationKey(jwk, header.alg);
    const isValidSignature = await this._verifySignature(
      `${encodedHeader}.${encodedPayload}.${signature}`,
      key,
    );

    if (!isValidSignature) {
      throw invalidTokenError();
    }

    this._validateClaims(payload);

    if (this.options?.checkRevocation) {
      await this.#checkRevocation(payload.jti);
    }

    return payload;
  }

  async verifyAndCheckScope(
    token: string,
    requiredScope: string,
  ): Promise<RelayAuthTokenClaims> {
    const claims = await this.verify(token);
    ScopeChecker.fromToken(claims).require(requiredScope);
    return claims;
  }

  async verifyOrNull(token: string): Promise<RelayAuthTokenClaims | null> {
    try {
      return await this.verify(token);
    } catch {
      return null;
    }
  }

  async _fetchJwks(forceRefresh = false): Promise<JWKSResponse> {
    const jwksUrl = this.options?.jwksUrl;
    if (!jwksUrl) {
      throw new RelayAuthError("JWKS URL is required", "missing_jwks_url", 500);
    }

    const now = Date.now();
    if (!forceRefresh && this.#jwksCache && this.#jwksCache.expiresAt > now) {
      return {
        keys: this.#jwksCache.keys,
      };
    }

    let response: Response;
    try {
      response = await fetch(jwksUrl);
    } catch {
      throw new RelayAuthError("Failed to fetch JWKS", "jwks_fetch_failed", 502);
    }

    if (!response.ok) {
      throw new RelayAuthError("Failed to fetch JWKS", "jwks_fetch_failed", response.status);
    }

    const payload = await parseJsonResponse(response);
    if (!isJwksResponse(payload)) {
      throw new RelayAuthError("Invalid JWKS response", "invalid_jwks", 502);
    }

    this.#jwksCache = {
      expiresAt: now + normalizeCacheTtlMs(this.options?.cacheTtlMs),
      keys: payload.keys,
    };

    return {
      keys: this.#jwksCache.keys,
    };
  }

  async _findKey(kid?: string, alg?: string): Promise<JsonWebKey> {
    const { keys } = await this._fetchJwks();
    let key = selectJwk(keys, kid, alg);

    if (!key) {
      const refreshed = await this._fetchJwks(true);
      key = selectJwk(refreshed.keys, kid, alg);
    }

    if (!key) {
      throw invalidTokenError();
    }

    return key;
  }

  _decodeHeader(token: string): JwtHeader {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw invalidTokenError();
    }

    const header = decodeBase64UrlJson<JwtHeader>(parts[0]);
    if (!header || typeof header !== "object") {
      throw invalidTokenError();
    }

    return header;
  }

  async _verifySignature(token: string, key: CryptoKey): Promise<boolean> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return false;
      }

      const header = this._decodeHeader(token);
      const algorithm = resolveVerificationAlgorithm(header.alg);
      if (!algorithm) {
        return false;
      }

      return await crypto.subtle.verify(
        algorithm,
        key,
        decodeBase64UrlToArrayBuffer(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
    } catch {
      return false;
    }
  }

  _validateClaims(claims: unknown): asserts claims is RelayAuthTokenClaims {
    const now = Math.floor(Date.now() / 1000);
    const notBeforeLeeway = 30;

    if (!isRelayAuthTokenClaims(claims)) {
      throw invalidTokenError();
    }

    if (claims.nbf !== undefined && claims.nbf > now + notBeforeLeeway) {
      throw invalidTokenError();
    }

    if (claims.exp <= now - notBeforeLeeway) {
      throw new TokenExpiredError();
    }

    if (this.options?.issuer && claims.iss !== this.options.issuer) {
      throw invalidTokenError();
    }

    if (
      this.options?.audience &&
      !this.options.audience.some((audience) => claims.aud.includes(audience))
    ) {
      throw invalidTokenError();
    }

    if (this.options?.maxAge !== undefined && claims.iat + this.options.maxAge < now) {
      throw new TokenExpiredError();
    }
  }

  #parseToken(token: string): ParsedToken {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw invalidTokenError();
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const header = this._decodeHeader(token);
    const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);

    if (!payload) {
      throw invalidTokenError();
    }

    return {
      encodedHeader,
      encodedPayload,
      header,
      payload,
      signature,
    };
  }

  async #checkRevocation(jti: string): Promise<void> {
    const revocationUrl = this.options?.revocationUrl;
    if (!revocationUrl) {
      throw new RelayAuthError("Revocation URL is required", "missing_revocation_url", 500);
    }

    const url = new URL(revocationUrl);
    url.searchParams.set("jti", jti);

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new RelayAuthError("Failed to check token revocation", "revocation_check_failed", 502);
    }

    if (!response.ok) {
      throw new RelayAuthError(
        "Failed to check token revocation",
        "revocation_check_failed",
        response.status,
      );
    }

    const payload = await parseJsonResponse(response);
    if (!payload || typeof payload !== "object") {
      throw new RelayAuthError("Invalid revocation response", "invalid_revocation_response", 502);
    }

    if ((payload as { revoked?: unknown }).revoked === true) {
      throw new TokenRevokedError();
    }
  }
}

function invalidTokenError(): RelayAuthError {
  return new RelayAuthError("Invalid access token", "invalid_token", 401);
}

function isSupportedAlgorithm(alg: string | undefined): alg is "RS256" | "EdDSA" {
  return alg === "RS256" || alg === "EdDSA";
}

function resolveVerificationAlgorithm(
  alg: string | undefined,
): AlgorithmIdentifier | RsaHashedImportParams | null {
  switch (alg) {
    case "RS256":
      return {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      };
    case "EdDSA":
      return {
        name: "Ed25519",
      };
    default:
      return null;
  }
}

async function importVerificationKey(
  jwk: JsonWebKey,
  alg: string | undefined,
): Promise<CryptoKey> {
  const algorithm = resolveVerificationAlgorithm(alg);
  if (!algorithm) {
    throw invalidTokenError();
  }

  try {
    return await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  } catch {
    throw invalidTokenError();
  }
}

function selectJwk(
  keys: JsonWebKey[],
  kid: string | undefined,
  alg: string | undefined,
): JsonWebKey | undefined {
  const matchingKeys = keys.filter((key) => matchesJwk(key, kid, alg));

  if (kid) {
    return matchingKeys[0];
  }

  return matchingKeys.length === 1 ? matchingKeys[0] : undefined;
}

function matchesJwk(key: JsonWebKey, kid: string | undefined, alg: string | undefined): boolean {
  const candidate = key as VerifierJwk;

  if (kid && candidate.kid !== kid) {
    return false;
  }

  if (alg && candidate.alg && candidate.alg !== alg) {
    return false;
  }

  if (candidate.use && candidate.use !== "sig") {
    return false;
  }

  if (alg === "RS256") {
    return candidate.kty === "RSA";
  }

  if (alg === "EdDSA") {
    return candidate.kty === "OKP" && candidate.crv === "Ed25519";
  }

  return false;
}

function isRelayAuthTokenClaims(value: unknown): value is RelayAuthTokenClaims {
  if (!value || typeof value !== "object") {
    return false;
  }

  const claims = value as Partial<RelayAuthTokenClaims>;
  return (
    typeof claims.sub === "string" &&
    typeof claims.org === "string" &&
    typeof claims.wks === "string" &&
    Array.isArray(claims.scopes) &&
    claims.scopes.every((scope) => typeof scope === "string") &&
    typeof claims.sponsorId === "string" &&
    Array.isArray(claims.sponsorChain) &&
    claims.sponsorChain.every((sponsor) => typeof sponsor === "string") &&
    (claims.token_type === "access" || claims.token_type === "refresh") &&
    typeof claims.iss === "string" &&
    Array.isArray(claims.aud) &&
    claims.aud.every((audience) => typeof audience === "string") &&
    typeof claims.exp === "number" &&
    Number.isFinite(claims.exp) &&
    typeof claims.iat === "number" &&
    Number.isFinite(claims.iat) &&
    typeof claims.jti === "string" &&
    (claims.nbf === undefined || (typeof claims.nbf === "number" && Number.isFinite(claims.nbf))) &&
    (claims.sid === undefined || typeof claims.sid === "string") &&
    (claims.parentTokenId === undefined || typeof claims.parentTokenId === "string") &&
    isStringRecord(claims.meta) &&
    isTokenBudget(claims.budget)
  );
}

function isTokenBudget(value: RelayAuthTokenClaims["budget"] | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const budget = value as Record<string, unknown>;
  return (
    isOptionalNumber(budget.maxActionsPerHour) &&
    isOptionalNumber(budget.maxCostPerDay) &&
    isOptionalNumber(budget.remaining)
  );
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isJwksResponse(value: unknown): value is JWKSResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeCacheTtlMs(cacheTtlMs: number | undefined): number {
  if (cacheTtlMs === undefined || !Number.isFinite(cacheTtlMs)) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return Math.max(0, cacheTtlMs);
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlToBytes(value));
}

function decodeBase64UrlToArrayBuffer(value: string): ArrayBuffer {
  const bytes = decodeBase64UrlToBytes(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return bytes;
}
