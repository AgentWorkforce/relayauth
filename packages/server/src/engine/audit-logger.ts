import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";
import type { AuthStorage, AuditStorage } from "../storage/index.js";
import { resolveAuditStorage, resolveContextStorage } from "../storage/index.js";
import { decodeBase64UrlJson } from "../lib/jwt.js";
import { verifyRs256Token } from "../lib/token-verifier.js";

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
      const validation = await validateAuthorizationHeader(authorization, c.env);
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
          ip: extractClientIp(c.req.header("X-Real-IP"), c.req.header("X-Forwarded-For")),
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
  env: AppEnv["Bindings"],
): Promise<TokenValidationResult> {
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return { ok: false, reason: "invalid_authorization_header" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "invalid_token_shape" };
  }

  const [, encodedPayload] = parts;
  const claims = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);

  try {
    const verifiedClaims = await verifyRs256Token(token, env);
    return { ok: true, claims: verifiedClaims };
  } catch {
    if (!claims) {
      return { ok: false, reason: "invalid_token_claims" };
    }
    return { ok: false, claims, reason: "invalid_token" };
  }
}

function extractClientIp(
  realIp: string | undefined,
  xForwardedFor: string | undefined,
): string | undefined {
  const direct = validateOptionalString(realIp);
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
