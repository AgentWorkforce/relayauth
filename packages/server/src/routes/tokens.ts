import type { RelayAuthTokenClaims, TokenPair } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk";
import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { authenticateAndAuthorize } from "../lib/auth.js";
import { decodeBase64UrlJson, verifyHs256Signature } from "../lib/jwt.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import type { AuthStorage, RevocationStorage } from "../storage/index.js";

type IssueTokenRequest = {
  identityId?: string;
  scopes?: unknown;
  audience?: unknown;
  expiresIn?: unknown;
};

type RefreshTokenRequest = {
  refreshToken?: string;
};

type RevokeTokenRequest = {
  tokenId?: string;
  identityId?: string;
  sessionId?: string;
};

type JwtHeader = {
  alg?: string;
  typ?: string;
  kid?: string;
};

type TokenRow = {
  id?: string | null;
  token_id?: string | null;
  jti?: string | null;
  identity_id?: string | null;
  status?: string | null;
  session_id?: string | null;
  expires_at?: number | string | null;
};

type SqlPrepared = {
  bind(...params: unknown[]): {
    all<T = unknown>(): Promise<{ results: T[] }>;
    first<T = unknown>(): Promise<T | null>;
    run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
  };
};

type SqlBackedStorage = AuthStorage & {
  DB: {
    prepare(sql: string): SqlPrepared;
  };
  revocations: RevocationStorage & {
    isRevoked?(jti: string): Promise<boolean>;
    revoke?(jti: string, expiresAt: number): Promise<void>;
  };
};

const tokens = new Hono<AppEnv>();

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 24 * 3600;

const SELECT_TOKEN_BY_ID_SQL = `
  SELECT id, token_id, jti, identity_id, status, session_id, expires_at
  FROM tokens
  WHERE id = ? OR token_id = ? OR jti = ?
  LIMIT 1
`;

const SELECT_TOKENS_BY_IDENTITY_SQL = `
  SELECT id, token_id, jti, identity_id, status, session_id, expires_at
  FROM tokens
  WHERE identity_id = ? AND status = 'active'
`;

const SELECT_TOKENS_BY_SESSION_SQL = `
  SELECT id, token_id, jti, identity_id, status, session_id, expires_at
  FROM tokens
  WHERE session_id = ? AND status = 'active'
`;

const INSERT_TOKEN_SQL = `
  INSERT INTO tokens (
    id,
    token_id,
    jti,
    identity_id,
    session_id,
    issued_at,
    expires_at,
    status,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
`;

tokens.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:token:create:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const body = await parseJsonObjectBody<IssueTokenRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const identityId = normalizeOptionalString(body.identityId);
  if (!identityId) {
    return c.json({ error: "identityId is required" }, 400);
  }

  const storage = getSqlStorage(c.get("storage"));
  const identity = await storage.identities.get(identityId);
  if (!identity || identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const accessScopes = normalizeScopes(body.scopes, identity.scopes);
  if (!scopesWithinGrant(accessScopes, identity.scopes)) {
    return c.json({ error: "insufficient_scope" }, 403);
  }
  const accessAudience = normalizeAudience(body.audience, accessScopes);
  const accessExpiresIn = normalizeExpiresIn(body.expiresIn);

  const tokenPair = await issueTokenPair(storage, c.env, identity, {
    accessScopes,
    accessAudience,
    accessExpiresIn,
    action: "token.issued",
  });

  return c.json(tokenPair, 201);
});

tokens.post("/refresh", async (c) => {
  const body = await parseJsonObjectBody<RefreshTokenRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const refreshToken = normalizeOptionalString(body.refreshToken);
  if (!refreshToken) {
    return c.json({ error: "refreshToken is required" }, 400);
  }

  const storage = getSqlStorage(c.get("storage"));
  const verification = await verifyLegacyToken(refreshToken, c.env.SIGNING_KEY);
  if (!verification.ok) {
    return c.json({ error: verification.error }, 401);
  }

  if (verification.claims.token_type !== "refresh") {
    return c.json({ error: "Invalid refresh token" }, 401);
  }

  if (await isTokenRevoked(storage, verification.claims.jti)) {
    return c.json({ error: "Refresh token has been revoked" }, 401);
  }

  const storedRefreshToken = await findStoredTokenById(storage, verification.claims.jti);
  if (!storedRefreshToken || storedRefreshToken.status !== "active") {
    return c.json({ error: "Refresh token not found" }, 401);
  }

  const identity = await storage.identities.get(verification.claims.sub);
  if (!identity || identity.status !== "active") {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const tokenPair = await issueTokenPair(storage, c.env, identity, {
    accessScopes: normalizeScopes(undefined, identity.scopes),
    accessAudience: normalizeAudience(undefined, identity.scopes),
    accessExpiresIn: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    sessionId: verification.claims.sid,
    action: "token.refreshed",
  });

  return c.json(tokenPair, 200);
});

tokens.post("/revoke", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:token:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const body = await parseJsonObjectBody<RevokeTokenRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tokenId = normalizeOptionalString(body.tokenId);
  const identityId = normalizeOptionalString(body.identityId);
  const sessionId = normalizeOptionalString(body.sessionId);
  if (!tokenId && !identityId && !sessionId) {
    return c.json({ error: "tokenId, identityId, or sessionId is required" }, 400);
  }

  const storage = getSqlStorage(c.get("storage"));
  const targetTokens = tokenId
    ? await findTargetTokensByTokenId(storage, tokenId)
    : identityId
      ? await findTargetTokensByIdentityId(storage, identityId)
      : await findTargetTokensBySessionId(storage, sessionId!);

  if (targetTokens.length === 0) {
    return c.json({ error: "token_not_found" }, 404);
  }

  const firstIdentityId = normalizeOptionalString(targetTokens[0]?.identity_id);
  const identity = firstIdentityId ? await storage.identities.get(firstIdentityId) : null;
  if (!identity || identity.orgId !== auth.claims.org) {
    return c.json({ error: "token_not_found" }, 404);
  }

  const revokedAt = new Date().toISOString();
  const revocableIds = targetTokens
    .map((row) => getTokenIdentifier(row))
    .filter((value): value is string => Boolean(value));
  await storage.revocations.revokeIdentityTokens(identity.id, revocableIds, revokedAt);

  await writeTokenAudit(storage, {
    action: "token.revoked",
    identity,
    tokenId: revocableIds[0] ?? tokenId ?? sessionId ?? identityId ?? identity.id,
    actorId: auth.claims.sub,
  });

  return c.body(null, 204);
});

tokens.get("/introspect", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:token:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const token = normalizeOptionalString(c.req.query("token"));
  if (!token) {
    return c.json({ error: "token query parameter is required" }, 400);
  }

  const storage = getSqlStorage(c.get("storage"));
  const verification = await verifyLegacyToken(token, c.env.SIGNING_KEY);
  if (!verification.ok) {
    return c.json(null, 200);
  }

  if (await isTokenRevoked(storage, verification.claims.jti)) {
    return c.json(null, 200);
  }

  const storedToken = await findStoredTokenById(storage, verification.claims.jti);
  if (!storedToken || storedToken.status !== "active") {
    return c.json(null, 200);
  }

  if (verification.claims.org !== auth.claims.org) {
    return c.json(null, 200);
  }

  return c.json(verification.claims, 200);
});

export default tokens;

async function issueTokenPair(
  storage: SqlBackedStorage,
  env: AppEnv["Bindings"],
  identity: StoredIdentity,
  options: {
    accessScopes: string[];
    accessAudience: string[];
    accessExpiresIn: number;
    sessionId?: string;
    action: "token.issued" | "token.refreshed";
  },
): Promise<TokenPair> {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const sessionId = options.sessionId ?? createSessionId();
  const accessClaims: RelayAuthTokenClaims = {
    sub: identity.id,
    org: identity.orgId,
    wks: identity.workspaceId,
    scopes: options.accessScopes,
    sponsorId: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    token_type: "access",
    iss: "https://relayauth.dev",
    aud: options.accessAudience,
    exp: issuedAtSeconds + options.accessExpiresIn,
    iat: issuedAtSeconds,
    jti: createTokenId(),
    sid: sessionId,
  };

  const refreshClaims: RelayAuthTokenClaims = {
    sub: identity.id,
    org: identity.orgId,
    wks: identity.workspaceId,
    scopes: ["relayauth:token:refresh"],
    sponsorId: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    token_type: "refresh",
    iss: "https://relayauth.dev",
    aud: ["relayauth"],
    exp: issuedAtSeconds + DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    iat: issuedAtSeconds,
    jti: createTokenId(),
    sid: sessionId,
  };

  const accessToken = await signHs256Jwt(accessClaims, env.SIGNING_KEY, env.SIGNING_KEY_ID);
  const refreshToken = await signHs256Jwt(refreshClaims, env.SIGNING_KEY, env.SIGNING_KEY_ID);

  await persistIssuedToken(storage, identity.id, accessClaims);
  await persistIssuedToken(storage, identity.id, refreshClaims);
  await writeTokenAudit(storage, {
    action: options.action,
    identity,
    tokenId: accessClaims.jti,
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(accessClaims.exp * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(refreshClaims.exp * 1000).toISOString(),
    tokenType: "Bearer",
  };
}

async function persistIssuedToken(
  storage: SqlBackedStorage,
  identityId: string,
  claims: RelayAuthTokenClaims,
): Promise<void> {
  const createdAt = new Date(claims.iat * 1000).toISOString();
  await storage.DB.prepare(INSERT_TOKEN_SQL)
    .bind(
      claims.jti,
      claims.jti,
      claims.jti,
      identityId,
      claims.sid ?? null,
      claims.iat,
      claims.exp,
      createdAt,
    )
    .run();
}

async function writeTokenAudit(
  storage: SqlBackedStorage,
  options: {
    action: "token.issued" | "token.refreshed" | "token.revoked";
    identity: StoredIdentity;
    tokenId: string;
    actorId?: string;
  },
): Promise<void> {
  await storage.audit.write({
    id: crypto.randomUUID(),
    action: options.action,
    identityId: options.identity.id,
    orgId: options.identity.orgId,
    workspaceId: options.identity.workspaceId,
    plane: "relayauth",
    resource: "tokens",
    result: "allowed",
    metadata: {
      tokenId: options.tokenId,
      ...(options.actorId ? { actorId: options.actorId } : {}),
    },
    timestamp: new Date().toISOString(),
  });
}

async function findTargetTokensByTokenId(storage: SqlBackedStorage, tokenId: string): Promise<TokenRow[]> {
  const row = await findStoredTokenById(storage, tokenId);
  return row ? [row] : [];
}

async function findTargetTokensByIdentityId(storage: SqlBackedStorage, identityId: string): Promise<TokenRow[]> {
  const normalizedIdentityId = normalizeOptionalString(identityId);
  if (!normalizedIdentityId) {
    return [];
  }

  const result = await storage.DB.prepare(SELECT_TOKENS_BY_IDENTITY_SQL).bind(normalizedIdentityId).all<TokenRow>();
  return result.results;
}

async function findTargetTokensBySessionId(storage: SqlBackedStorage, sessionId: string): Promise<TokenRow[]> {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return [];
  }

  const result = await storage.DB.prepare(SELECT_TOKENS_BY_SESSION_SQL).bind(normalizedSessionId).all<TokenRow>();
  return result.results;
}

async function findStoredTokenById(storage: SqlBackedStorage, tokenId: string): Promise<TokenRow | null> {
  const normalizedTokenId = normalizeOptionalString(tokenId);
  if (!normalizedTokenId) {
    return null;
  }

  return storage.DB.prepare(SELECT_TOKEN_BY_ID_SQL)
    .bind(normalizedTokenId, normalizedTokenId, normalizedTokenId)
    .first<TokenRow>();
}

async function isTokenRevoked(storage: SqlBackedStorage, jti: string): Promise<boolean> {
  if (typeof storage.revocations.isRevoked === "function") {
    return storage.revocations.isRevoked(jti);
  }

  return false;
}

async function verifyLegacyToken(
  token: string,
  signingKey: string,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string }
> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "Invalid token" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const claims = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !claims || header.alg !== "HS256") {
    return { ok: false, error: "Invalid token" };
  }

  const validSignature = await verifyHs256Signature(`${encodedHeader}.${encodedPayload}`, signature, signingKey);
  if (!validSignature) {
    return { ok: false, error: "Invalid token" };
  }

  if (!isValidClaims(claims)) {
    return { ok: false, error: "Invalid token" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.nbf === "number" && claims.nbf > now) {
    return { ok: false, error: "Invalid token" };
  }

  if (claims.exp <= now) {
    return { ok: false, error: "Token expired" };
  }

  return { ok: true, claims };
}

function isValidClaims(value: RelayAuthTokenClaims): boolean {
  return typeof value.sub === "string"
    && typeof value.org === "string"
    && typeof value.wks === "string"
    && typeof value.sponsorId === "string"
    && Array.isArray(value.sponsorChain)
    && Array.isArray(value.scopes)
    && Array.isArray(value.aud)
    && typeof value.jti === "string"
    && typeof value.iat === "number"
    && typeof value.exp === "number"
    && (value.token_type === "access" || value.token_type === "refresh");
}

async function signHs256Jwt(
  claims: RelayAuthTokenClaims,
  signingKey: string,
  signingKeyId: string,
): Promise<string> {
  const header: JwtHeader = {
    alg: "HS256",
    typ: "JWT",
    kid: signingKeyId,
  };

  const encodedHeader = encodeBase64UrlJson(header);
  const encodedPayload = encodeBase64UrlJson(claims);
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${encodeBase64UrlBytes(new Uint8Array(signature))}`;
}

function encodeBase64UrlJson(value: unknown): string {
  return encodeBase64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeScopes(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const scopes = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return scopes.length > 0 ? scopes : [...fallback];
}

function normalizeAudience(value: unknown, scopes: string[]): string[] {
  if (Array.isArray(value)) {
    const audience = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (audience.length > 0) {
      return audience;
    }
  }

  const derived = [...new Set(scopes
    .map((scope) => scope.split(":", 1)[0]?.trim())
    .filter((segment): segment is string => Boolean(segment)))];
  return derived.length > 0 ? derived : ["relayauth"];
}

function scopesWithinGrant(requestedScopes: string[], grantedScopes: string[]): boolean {
  return requestedScopes.every((requestedScope) => {
    if (grantedScopes.includes(requestedScope)) {
      return true;
    }

    try {
      return matchScope(requestedScope, grantedScopes);
    } catch {
      return false;
    }
  });
}

function normalizeExpiresIn(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
}

async function parseJsonObjectBody<T extends object>(request: Request): Promise<T | null> {
  const raw = await request.clone().text().catch(() => "");
  if (!raw.trim()) {
    return {} as T;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getSqlStorage(storage: AuthStorage): SqlBackedStorage {
  return storage as SqlBackedStorage;
}

function getTokenIdentifier(row: TokenRow): string | undefined {
  return normalizeOptionalString(row.id)
    ?? normalizeOptionalString(row.jti)
    ?? normalizeOptionalString(row.token_id);
}

function createTokenId(): string {
  return `tok_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createSessionId(): string {
  return `sess_${crypto.randomUUID().replace(/-/g, "")}`;
}
