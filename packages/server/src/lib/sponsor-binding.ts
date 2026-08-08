import type { SponsorBinding } from "@relayauth/types";
import { rsaPublicJwkFromPem } from "./jwk.js";
import {
  encodeBytesAsBase64Url,
  keyIdFromPublicJwk,
  signRs256,
} from "./sign-rs256.js";
import {
  decodeBase64UrlJson,
  decodeBase64UrlToBytes,
  splitJwtSegments,
} from "./jwt.js";

const SPONSOR_GRANT_AUDIENCE = "relayauth:sponsor-binding";
const SPONSOR_GRANT_TOKEN_TYPE = "sponsor_grant";
const DEFAULT_GRANT_TTL_SECONDS = 300;
const MAX_GRANT_TTL_SECONDS = 900;
const DEFAULT_ID_TOKEN_MAX_AGE_SECONDS = 300;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_JWKS_CACHE_SECONDS = 300;
const MAX_JWKS_CACHE_SECONDS = 3600;
const FETCH_TIMEOUT_MS = 5_000;
const SPONSOR_ID_PATTERN = /^user_[A-Za-z0-9_-]+$/u;

export type SponsorFederationConfig =
  | {
      sponsorBinding: "legacy";
    }
  | {
      sponsorBinding: "oidc";
      issuer: string;
      clientId: string;
      allowedAudiences?: string[];
      sponsorIdClaim?: string;
      sponsorIdPrefix?: string;
      jwksUri?: string;
      jwks?: JsonWebKeySet;
      grantTtlSeconds?: number;
      maxIdTokenAgeSeconds?: number;
      clockSkewSeconds?: number;
    };

export type SponsorFederationMap = Record<string, SponsorFederationConfig>;

export type SponsorBindingEnv = {
  BASE_URL?: string;
  RELAYAUTH_SIGNING_KEY_PEM?: string;
  RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?: string;
  RELAYAUTH_SPONSOR_FEDERATIONS?: string;
};

export type VerifiedOidcSponsor = {
  sponsorId: string;
  issuer: string;
  subject: string;
  iat: number;
  jti?: string;
};

export type IssuedSponsorProof = {
  sponsorId: string;
  sponsorProof: string;
  expiresAt: string;
};

type JsonWebKeySet = {
  keys: JsonWebKey[];
};

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
  crit?: unknown;
};

type OidcIdTokenClaims = Record<string, unknown> & {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  jti?: unknown;
};

type SponsorGrantClaims = {
  iss: string;
  aud: string;
  sub: string;
  org: string;
  iat: number;
  exp: number;
  jti: string;
  token_type: typeof SPONSOR_GRANT_TOKEN_TYPE;
  oidc: {
    issuer: string;
    subject: string;
    iat: number;
    jti?: string;
  };
};

type CachedJwks = {
  expiresAt: number;
  jwks: JsonWebKeySet;
};

type OidcDiscoveryDocument = {
  issuer?: unknown;
  jwks_uri?: unknown;
};

export class SponsorBindingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 503,
  ) {
    super(message);
    this.name = "SponsorBindingError";
  }
}

export class SponsorOidcService {
  readonly #jwksCache = new Map<string, CachedJwks>();
  readonly #discoveryCache = new Map<string, { expiresAt: number; jwksUri: string }>();

  resolveConfig(env: SponsorBindingEnv, orgId: string): SponsorFederationConfig {
    const raw = env.RELAYAUTH_SPONSOR_FEDERATIONS?.trim();
    if (!raw) {
      return { sponsorBinding: "legacy" };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw configurationError("RELAYAUTH_SPONSOR_FEDERATIONS must be valid JSON");
    }

    if (!isRecord(decoded)) {
      throw configurationError("RELAYAUTH_SPONSOR_FEDERATIONS must be an object keyed by org id");
    }

    const value = decoded[orgId];
    if (value === undefined) {
      return { sponsorBinding: "legacy" };
    }

    return parseFederationConfig(value);
  }

  async verifyIdToken(
    idToken: string,
    config: Extract<SponsorFederationConfig, { sponsorBinding: "oidc" }>,
  ): Promise<VerifiedOidcSponsor> {
    const parts = splitJwtSegments(idToken);
    if (!parts) {
      throw invalidIdToken();
    }

    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
    const claims = decodeBase64UrlJson<OidcIdTokenClaims>(encodedClaims);
    if (
      !header
      || header.alg !== "RS256"
      || typeof header.kid !== "string"
      || !header.kid
      || header.crit !== undefined
      || !claims
    ) {
      throw invalidIdToken();
    }

    let jwks = await this.#resolveJwks(config, false);
    let key = selectVerificationKey(jwks, header.kid);
    if (!key && !config.jwks) {
      jwks = await this.#resolveJwks(config, true);
      key = selectVerificationKey(jwks, header.kid);
    }
    if (!key) {
      throw invalidIdToken();
    }

    const validSignature = await verifyRs256Signature(
      `${encodedHeader}.${encodedClaims}`,
      encodedSignature,
      key,
    ).catch(() => false);
    if (!validSignature) {
      throw invalidIdToken();
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = boundedInteger(config.clockSkewSeconds, DEFAULT_CLOCK_SKEW_SECONDS, 0, 300);
    const maxAge = boundedInteger(
      config.maxIdTokenAgeSeconds,
      DEFAULT_ID_TOKEN_MAX_AGE_SECONDS,
      30,
      3600,
    );
    const issuer = requireClaimString(claims.iss);
    const subject = requireClaimString(claims.sub);
    const iat = requireClaimInteger(claims.iat);
    const expiresAt = requireClaimInteger(claims.exp);
    const notBefore = claims.nbf === undefined ? undefined : requireClaimInteger(claims.nbf);

    if (
      issuer !== config.issuer
      || iat > now + skew
      || now - iat > maxAge + skew
      || expiresAt <= now - skew
      || (notBefore !== undefined && notBefore > now + skew)
      || !hasAllowedAudience(claims.aud, config)
    ) {
      throw invalidIdToken();
    }

    const audiences = normalizeAudience(claims.aud);
    if (
      audiences.length > 1
      && (typeof claims.azp !== "string" || claims.azp !== config.clientId)
    ) {
      throw invalidIdToken();
    }

    const sponsorClaim = config.sponsorIdClaim ?? "sub";
    const sponsorClaimValue = requireClaimString(claims[sponsorClaim]);
    const sponsorId = mapSponsorId(sponsorClaimValue, config.sponsorIdPrefix ?? "user_");
    const jti = typeof claims.jti === "string" && claims.jti.trim()
      ? claims.jti.trim()
      : undefined;

    return {
      sponsorId,
      issuer,
      subject,
      iat,
      ...(jti ? { jti } : {}),
    };
  }

  async issueSponsorProof(
    env: SponsorBindingEnv,
    orgId: string,
    sponsor: VerifiedOidcSponsor,
    config: Extract<SponsorFederationConfig, { sponsorBinding: "oidc" }>,
  ): Promise<IssuedSponsorProof> {
    const privateKey = env.RELAYAUTH_SIGNING_KEY_PEM?.trim();
    const publicKey = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
    if (!privateKey || !publicKey) {
      throw configurationError("RelayAuth signing keys are required for sponsor proofs");
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = boundedInteger(
      config.grantTtlSeconds,
      DEFAULT_GRANT_TTL_SECONDS,
      30,
      MAX_GRANT_TTL_SECONDS,
    );
    const exp = now + ttl;
    const publicJwk = await rsaPublicJwkFromPem(publicKey, "");
    const kid = await keyIdFromPublicJwk(publicJwk);
    const claims: SponsorGrantClaims = {
      iss: sponsorGrantIssuer(env),
      aud: SPONSOR_GRANT_AUDIENCE,
      sub: sponsor.sponsorId,
      org: orgId,
      iat: now,
      exp,
      jti: `spg_${crypto.randomUUID().replace(/-/gu, "")}`,
      token_type: SPONSOR_GRANT_TOKEN_TYPE,
      oidc: {
        issuer: sponsor.issuer,
        subject: sponsor.subject,
        iat: sponsor.iat,
        ...(sponsor.jti ? { jti: sponsor.jti } : {}),
      },
    };

    return {
      sponsorId: sponsor.sponsorId,
      sponsorProof: await signRs256(claims, privateKey, kid),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async verifySponsorProof(
    env: SponsorBindingEnv,
    proof: string,
    expectedOrgId: string,
    expectedSponsorId: string,
  ): Promise<Extract<SponsorBinding, { mode: "oidc" }>> {
    const publicKeyPem = env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
    if (!publicKeyPem) {
      throw configurationError("RelayAuth public signing key is required for sponsor proofs");
    }

    const parts = splitJwtSegments(proof);
    if (!parts) {
      throw invalidSponsorProof();
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
    const claims = decodeBase64UrlJson<SponsorGrantClaims>(encodedClaims);
    const publicJwk = await rsaPublicJwkFromPem(publicKeyPem, "");
    const expectedKid = await keyIdFromPublicJwk(publicJwk);
    if (
      !header
      || header.alg !== "RS256"
      || header.kid !== expectedKid
      || header.crit !== undefined
      || !claims
    ) {
      throw invalidSponsorProof();
    }

    const validSignature = await verifyRs256Signature(
      `${encodedHeader}.${encodedClaims}`,
      encodedSignature,
      publicJwk,
    ).catch(() => false);
    const now = Math.floor(Date.now() / 1000);
    if (
      !validSignature
      || claims.iss !== sponsorGrantIssuer(env)
      || claims.aud !== SPONSOR_GRANT_AUDIENCE
      || claims.token_type !== SPONSOR_GRANT_TOKEN_TYPE
      || claims.org !== expectedOrgId
      || claims.sub !== expectedSponsorId
      || !Number.isInteger(claims.iat)
      || !Number.isInteger(claims.exp)
      || claims.iat > now + DEFAULT_CLOCK_SKEW_SECONDS
      || claims.exp <= now
      || !isRecord(claims.oidc)
      || typeof claims.oidc.issuer !== "string"
      || typeof claims.oidc.subject !== "string"
      || !Number.isInteger(claims.oidc.iat)
    ) {
      throw invalidSponsorProof();
    }

    return {
      mode: "oidc",
      issuer: claims.oidc.issuer,
      subject: claims.oidc.subject,
      iat: claims.oidc.iat,
      ...(typeof claims.oidc.jti === "string" ? { jti: claims.oidc.jti } : {}),
    };
  }

  async #resolveJwks(
    config: Extract<SponsorFederationConfig, { sponsorBinding: "oidc" }>,
    forceRefresh: boolean,
  ): Promise<JsonWebKeySet> {
    if (config.jwks) {
      return validateJwks(config.jwks);
    }

    const jwksUri = config.jwksUri ?? await this.#resolveJwksUri(config, forceRefresh);
    assertSecureProviderUrl(jwksUri, "jwksUri");
    const cached = this.#jwksCache.get(jwksUri);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.jwks;
    }

    const response = await fetchProviderJson(jwksUri);
    const jwks = validateJwks(response.body);
    this.#jwksCache.set(jwksUri, {
      jwks,
      expiresAt: Date.now() + response.cacheSeconds * 1000,
    });
    return jwks;
  }

  async #resolveJwksUri(
    config: Extract<SponsorFederationConfig, { sponsorBinding: "oidc" }>,
    forceRefresh: boolean,
  ): Promise<string> {
    const cached = this.#discoveryCache.get(config.issuer);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.jwksUri;
    }

    const discoveryUrl = `${config.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
    assertSecureProviderUrl(discoveryUrl, "issuer");
    const response = await fetchProviderJson(discoveryUrl);
    const discovery = response.body as OidcDiscoveryDocument;
    if (
      !isRecord(discovery)
      || discovery.issuer !== config.issuer
      || typeof discovery.jwks_uri !== "string"
      || !discovery.jwks_uri
    ) {
      throw invalidIdToken();
    }
    assertSecureProviderUrl(discovery.jwks_uri, "jwks_uri");
    this.#discoveryCache.set(config.issuer, {
      jwksUri: discovery.jwks_uri,
      expiresAt: Date.now() + response.cacheSeconds * 1000,
    });
    return discovery.jwks_uri;
  }
}

export function sponsorBindingMode(
  service: SponsorOidcService,
  env: SponsorBindingEnv,
  orgId: string,
): SponsorFederationConfig["sponsorBinding"] {
  return service.resolveConfig(env, orgId).sponsorBinding;
}

function parseFederationConfig(value: unknown): SponsorFederationConfig {
  if (!isRecord(value)) {
    throw configurationError("Sponsor federation entry must be an object");
  }
  if (value.sponsorBinding === "legacy") {
    return { sponsorBinding: "legacy" };
  }
  if (value.sponsorBinding !== "oidc") {
    throw configurationError("sponsorBinding must be legacy or oidc");
  }

  const issuer = requireConfigString(value.issuer, "issuer");
  const clientId = requireConfigString(value.clientId, "clientId");
  assertSecureProviderUrl(issuer, "issuer");
  const allowedAudiences = optionalStringArray(value.allowedAudiences, "allowedAudiences");
  const sponsorIdClaim = optionalConfigString(value.sponsorIdClaim, "sponsorIdClaim");
  const sponsorIdPrefix = optionalConfigString(value.sponsorIdPrefix, "sponsorIdPrefix");
  const jwksUri = optionalConfigString(value.jwksUri, "jwksUri");
  if (jwksUri) {
    assertSecureProviderUrl(jwksUri, "jwksUri");
  }

  return {
    sponsorBinding: "oidc",
    issuer,
    clientId,
    ...(allowedAudiences ? { allowedAudiences } : {}),
    ...(sponsorIdClaim ? { sponsorIdClaim } : {}),
    ...(sponsorIdPrefix ? { sponsorIdPrefix } : {}),
    ...(jwksUri ? { jwksUri } : {}),
    ...(value.jwks !== undefined ? { jwks: validateJwks(value.jwks) } : {}),
    ...(optionalInteger(value.grantTtlSeconds, "grantTtlSeconds") !== undefined
      ? { grantTtlSeconds: optionalInteger(value.grantTtlSeconds, "grantTtlSeconds") }
      : {}),
    ...(optionalInteger(value.maxIdTokenAgeSeconds, "maxIdTokenAgeSeconds") !== undefined
      ? { maxIdTokenAgeSeconds: optionalInteger(value.maxIdTokenAgeSeconds, "maxIdTokenAgeSeconds") }
      : {}),
    ...(optionalInteger(value.clockSkewSeconds, "clockSkewSeconds") !== undefined
      ? { clockSkewSeconds: optionalInteger(value.clockSkewSeconds, "clockSkewSeconds") }
      : {}),
  };
}

function selectVerificationKey(jwks: JsonWebKeySet, kid: string): JsonWebKey | undefined {
  return jwks.keys.find((key) => {
    const candidate = key as JsonWebKey & { kid?: unknown; alg?: unknown; use?: unknown };
    return candidate.kid === kid
      && candidate.kty === "RSA"
      && (candidate.alg === undefined || candidate.alg === "RS256")
      && (candidate.use === undefined || candidate.use === "sig")
      && (!candidate.key_ops || candidate.key_ops.includes("verify"));
  });
}

async function verifyRs256Signature(
  signingInput: string,
  encodedSignature: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64UrlToBytes(encodedSignature),
    new TextEncoder().encode(signingInput),
  );
}

function hasAllowedAudience(
  value: unknown,
  config: Extract<SponsorFederationConfig, { sponsorBinding: "oidc" }>,
): boolean {
  const presented = normalizeAudience(value);
  const allowed = config.allowedAudiences?.length
    ? config.allowedAudiences
    : [config.clientId];
  return presented.some((audience) => allowed.includes(audience));
}

function normalizeAudience(value: unknown): string[] {
  if (typeof value === "string" && value) {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry)) {
    return value;
  }
  return [];
}

function mapSponsorId(claim: string, prefix: string): string {
  if (SPONSOR_ID_PATTERN.test(claim)) {
    return claim;
  }
  if (!/^user_[A-Za-z0-9_-]*$/u.test(prefix)) {
    throw configurationError("sponsorIdPrefix must begin with user_ and contain only token-safe characters");
  }
  const safeClaim = /^[A-Za-z0-9_-]+$/u.test(claim)
    ? claim
    : encodeBytesAsBase64Url(new TextEncoder().encode(claim));
  const sponsorId = `${prefix}${safeClaim}`;
  if (!SPONSOR_ID_PATTERN.test(sponsorId)) {
    throw invalidIdToken();
  }
  return sponsorId;
}

async function fetchProviderJson(url: string): Promise<{ body: unknown; cacheSeconds: number }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new SponsorBindingError("OIDC provider unavailable", "oidc_provider_unavailable", 503);
  }
  if (!response.ok) {
    throw new SponsorBindingError("OIDC provider unavailable", "oidc_provider_unavailable", 503);
  }
  try {
    return {
      body: await response.json(),
      cacheSeconds: parseCacheSeconds(response.headers.get("cache-control")),
    };
  } catch {
    throw new SponsorBindingError("OIDC provider returned invalid JSON", "oidc_provider_invalid", 503);
  }
}

function parseCacheSeconds(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl ?? "");
  if (!match) {
    return DEFAULT_JWKS_CACHE_SECONDS;
  }
  return Math.min(Number(match[1]), MAX_JWKS_CACHE_SECONDS);
}

function validateJwks(value: unknown): JsonWebKeySet {
  if (
    !isRecord(value)
    || !Array.isArray(value.keys)
    || value.keys.length === 0
    || value.keys.length > 100
    || !value.keys.every(isRecord)
  ) {
    throw configurationError("OIDC JWKS must contain between 1 and 100 keys");
  }
  return { keys: value.keys as JsonWebKey[] };
}

function sponsorGrantIssuer(env: SponsorBindingEnv): string {
  return env.BASE_URL?.trim() || "relayauth";
}

function assertSecureProviderUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(`${field} must be an absolute URL`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw configurationError(`${field} must use HTTPS (HTTP is allowed only for loopback fixtures)`);
  }
}

function requireClaimString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidIdToken();
  }
  return value.trim();
}

function requireClaimInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidIdToken();
  }
  return value;
}

function requireConfigString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw configurationError(`${field} is required`);
  }
  return value.trim();
}

function optionalConfigString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireConfigString(value, field);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw configurationError(`${field} must be a non-empty string array`);
  }
  return value.map((entry) => entry.trim());
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw configurationError(`${field} must be an integer`);
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (value < minimum || value > maximum) {
    throw configurationError(`Configured duration must be between ${minimum} and ${maximum} seconds`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidIdToken(): SponsorBindingError {
  return new SponsorBindingError("Invalid OIDC id_token", "invalid_id_token", 403);
}

function invalidSponsorProof(): SponsorBindingError {
  return new SponsorBindingError("Invalid sponsor proof", "invalid_sponsor_proof", 403);
}

function configurationError(message: string): SponsorBindingError {
  return new SponsorBindingError(message, "sponsor_binding_misconfigured", 503);
}
