import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";
import type { AuthStorage, AuditStorage } from "../storage/index.js";
import { resolveAuditStorage, resolveContextStorage } from "../storage/index.js";
import { decodeBase64UrlJson, verifyHs256Signature } from "../lib/jwt.js";

export type ExtendedAuditAction =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

export type AuditLoggerEntry = Omit<AuditEntry, "action"> & {
  action: ExtendedAuditAction;
};

type AuditLoggerInput = Partial<AuditLoggerEntry>;
type AuditStorageSource = AuditStorage | Pick<AuthStorage, "audit">;

type TokenValidationResult =
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; claims?: RelayAuthTokenClaims; reason: string };

type JwtHeader = {
  alg?: string;
  typ?: string;
};

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

let auditWriteFailureCount = 0;

export function getAuditWriteFailureCount(): number {
  return auditWriteFailureCount;
}

const SENSITIVE_ACTIONS = new Set<string>([
  "token.issued",
  "token.revoked",
  "identity.created",
  "identity.suspended",
  "identity.retired",
  "policy.created",
  "policy.deleted",
  "key.rotated",
]);

export async function writeAuditEntry(
  storageSource: AuditStorageSource,
  entry: AuditLoggerInput,
): Promise<void> {
  const normalized = normalizeAuditEntry(entry);
  const storage = resolveAuditStorage(storageSource);

  try {
    await storage.write(normalized);
  } catch (error) {
    auditWriteFailureCount++;
    console.error("Failed to write audit log entry to storage", error);
    if (SENSITIVE_ACTIONS.has(normalized.action)) {
      throw new Error("Audit write failed for sensitive operation");
    }
  }
}

export async function flushAuditBatch(
  storageSource: AuditStorageSource,
  entries: AuditLoggerInput[],
): Promise<void> {
  const normalizedEntries = entries.map((entry) => normalizeAuditEntry(entry));

  if (normalizedEntries.length === 0) {
    return;
  }

  const storage = resolveAuditStorage(storageSource);
  try {
    await storage.writeBatch(normalizedEntries);
  } catch (error) {
    auditWriteFailureCount += normalizedEntries.length;
    console.error("Failed to write audit log batch to storage", error);
    const hasSensitive = normalizedEntries.some((entry) => SENSITIVE_ACTIONS.has(entry.action));
    if (hasSensitive) {
      throw new Error("Audit batch write failed for sensitive operations");
    }
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

        await writeAuditEntry(resolveContextStorage(c), {
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
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function validateAuthorizationHeader(
  authorization: string,
  signingKey: string,
): Promise<TokenValidationResult> {
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return { ok: false, reason: "invalid_authorization_header" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "invalid_token_shape" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const claims = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !claims || header.alg !== "HS256") {
    return { ok: false, claims: claims ?? undefined, reason: "invalid_token_header" };
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    return { ok: false, claims, reason: "invalid_token_signature" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    return { ok: false, claims, reason: "token_expired" };
  }

  if (
    typeof claims.sub !== "string" ||
    typeof claims.org !== "string" ||
    typeof claims.wks !== "string" ||
    typeof claims.sponsorId !== "string" ||
    !Array.isArray(claims.sponsorChain) ||
    typeof claims.jti !== "string"
  ) {
    return { ok: false, claims, reason: "invalid_token_claims" };
  }

  return { ok: true, claims };
}

function extractClientIp(
  cfConnectingIp: string | undefined,
  xForwardedFor: string | undefined,
): string | undefined {
  const direct = validateOptionalString(cfConnectingIp);
  if (direct) {
    return direct;
  }

  const forwarded = validateOptionalString(xForwardedFor);
  if (!forwarded) {
    return undefined;
  }

  const first = forwarded.split(",")[0]?.trim();
  return first ? first : undefined;
}
