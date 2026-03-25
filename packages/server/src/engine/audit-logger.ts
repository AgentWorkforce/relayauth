import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";

export type ExtendedAuditAction =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

export type AuditLoggerEntry = Omit<AuditEntry, "action"> & {
  action: ExtendedAuditAction;
};

type AuditLoggerInput = Partial<AuditLoggerEntry>;

type TokenValidationResult =
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; claims?: RelayAuthTokenClaims; reason: string };

type JwtHeader = {
  alg?: string;
  typ?: string;
};

const AUDIT_LOG_INSERT_SQL = `
  INSERT INTO audit_logs (
    id,
    action,
    identity_id,
    org_id,
    workspace_id,
    plane,
    resource,
    result,
    metadata_json,
    ip,
    user_agent,
    timestamp
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const AUDIT_ACTIONS = new Set<ExtendedAuditAction>([
  "token.issued",
  "token.refreshed",
  "token.revoked",
  "token.validated",
  "identity.created",
  "identity.updated",
  "identity.suspended",
  "identity.retired",
  "scope.checked",
  "scope.denied",
  "role.assigned",
  "role.removed",
  "policy.created",
  "policy.updated",
  "policy.deleted",
  "key.rotated",
  "budget.exceeded",
  "budget.alert",
  "scope.escalation_denied",
]);

const AUDIT_RESULTS = new Set<AuditEntry["result"]>(["allowed", "denied", "error"]);
const BUDGET_ACTIONS = new Set<ExtendedAuditAction>(["budget.exceeded", "budget.alert"]);

export async function writeAuditEntry(db: D1Database, entry: AuditLoggerInput): Promise<void> {
  const normalized = normalizeAuditEntry(entry);

  try {
    await db.prepare(AUDIT_LOG_INSERT_SQL).bind(...toInsertParams(normalized)).run();
  } catch (error) {
    console.error("Failed to write audit log entry to D1", error);
  }
}

export async function flushAuditBatch(
  db: D1Database,
  entries: AuditLoggerInput[],
): Promise<void> {
  const normalizedEntries = entries.map((entry) => normalizeAuditEntry(entry));

  if (normalizedEntries.length === 0) {
    return;
  }

  try {
    const statements = normalizedEntries.map((entry) =>
      db.prepare(AUDIT_LOG_INSERT_SQL).bind(...toInsertParams(entry)),
    );
    await db.batch(statements);
  } catch (error) {
    console.error("Failed to write audit log batch to D1", error);
  }
}

export function createAuditMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");

    if (authorization) {
      const validation = await validateAuthorizationHeader(authorization, c.env.SIGNING_KEY);
      if (validation.claims) {
        const { claims } = validation;
        const metadata: Record<string, string> = {
          sponsorId: claims.sponsorId,
          sponsorChain: JSON.stringify(claims.sponsorChain),
          tokenId: claims.jti,
        };

        if (!validation.ok) {
          metadata.reason = validation.reason;
        }

        await writeAuditEntry(c.env.DB, {
          action: "token.validated",
          identityId: claims.sub,
          orgId: claims.org,
          workspaceId: claims.wks,
          plane: "relayauth",
          resource: c.req.path,
          result: validation.ok ? "allowed" : "denied",
          metadata,
          ip: extractClientIp(c.req.header("CF-Connecting-IP"), c.req.header("X-Forwarded-For")),
          userAgent: c.req.header("User-Agent") ?? undefined,
        });
      }
    }

    await next();
  };
}

function normalizeAuditEntry(entry: AuditLoggerInput): AuditLoggerEntry {
  const action = validateAction(entry.action);
  const identityId = validateNonEmptyString(entry.identityId, "identityId");
  const orgId = validateNonEmptyString(entry.orgId, "orgId");
  const result = validateResult(entry.result);
  const metadata = validateMetadata(action, entry.metadata);

  return {
    id: validateOptionalString(entry.id) ?? generateAuditId(),
    action,
    identityId,
    orgId,
    workspaceId: validateOptionalString(entry.workspaceId),
    plane: validateOptionalString(entry.plane),
    resource: validateOptionalString(entry.resource),
    result,
    metadata,
    ip: validateOptionalString(entry.ip),
    userAgent: validateOptionalString(entry.userAgent),
    timestamp: validateOptionalString(entry.timestamp) ?? new Date().toISOString(),
  };
}

function validateAction(action: AuditLoggerInput["action"]): ExtendedAuditAction {
  const value = validateNonEmptyString(action, "action") as ExtendedAuditAction;
  if (!AUDIT_ACTIONS.has(value)) {
    throw new Error(`Invalid audit action: ${value}`);
  }
  return value;
}

function validateResult(result: AuditLoggerInput["result"]): AuditEntry["result"] {
  const value = validateNonEmptyString(result, "result") as AuditEntry["result"];
  if (!AUDIT_RESULTS.has(value)) {
    throw new Error(`Invalid audit result: ${value}`);
  }
  return value;
}

function validateMetadata(
  action: ExtendedAuditAction,
  metadata: AuditLoggerInput["metadata"],
): Record<string, string> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("metadata is required");
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string") {
      throw new Error(`metadata.${key} must be a string`);
    }
    normalized[key] = value;
  }

  validateNonEmptyString(normalized.sponsorId, "metadata.sponsorId");
  validateNonEmptyString(normalized.sponsorChain, "metadata.sponsorChain");

  if (BUDGET_ACTIONS.has(action)) {
    validateNonEmptyString(normalized.budgetConfig, "metadata.budgetConfig");
    validateNonEmptyString(normalized.actualUsage, "metadata.actualUsage");
    validateNonEmptyString(normalized.actionAttempted, "metadata.actionAttempted");
  }

  if (action === "scope.escalation_denied") {
    validateNonEmptyString(normalized.actionAttempted, "metadata.actionAttempted");
  }

  return normalized;
}

function toInsertParams(entry: AuditLoggerEntry): unknown[] {
  return [
    entry.id,
    entry.action,
    entry.identityId,
    entry.orgId,
    entry.workspaceId ?? null,
    entry.plane ?? null,
    entry.resource ?? null,
    entry.result,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.ip ?? null,
    entry.userAgent ?? null,
    entry.timestamp,
  ];
}

function generateAuditId(): string {
  return `aud_${crypto.randomUUID()}`;
}

function validateNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function validateOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return validateNonEmptyString(value, "value");
}

async function validateAuthorizationHeader(
  authorization: string,
  signingKey: string,
): Promise<TokenValidationResult> {
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return { ok: false, reason: "invalid_authorization" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed_token" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  const claims = isRelayAuthClaims(payload) ? payload : undefined;

  if (!header || header.alg !== "HS256" || !payload) {
    return { ok: false, claims, reason: "malformed_token" };
  }

  if (!claims) {
    return { ok: false, reason: "invalid_claims" };
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    return { ok: false, claims, reason: "invalid_signature" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    return { ok: false, claims, reason: "expired_token" };
  }

  return { ok: true, claims };
}

function isRelayAuthClaims(payload: unknown): payload is RelayAuthTokenClaims {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const candidate = payload as Partial<RelayAuthTokenClaims>;
  return (
    typeof candidate.sub === "string" &&
    typeof candidate.org === "string" &&
    typeof candidate.wks === "string" &&
    typeof candidate.sponsorId === "string" &&
    typeof candidate.jti === "string" &&
    Array.isArray(candidate.sponsorChain)
  );
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
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function extractClientIp(
  cfConnectingIp: string | undefined,
  xForwardedFor: string | undefined,
): string | undefined {
  if (typeof cfConnectingIp === "string" && cfConnectingIp.trim().length > 0) {
    return cfConnectingIp.trim();
  }

  if (typeof xForwardedFor !== "string") {
    return undefined;
  }

  const [firstIp] = xForwardedFor.split(",", 1);
  return firstIp?.trim() || undefined;
}
