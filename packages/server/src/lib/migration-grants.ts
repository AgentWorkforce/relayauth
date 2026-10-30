import crypto from "node:crypto";

import type { AuditLogWriteEntry, AuthStorage } from "../storage/index.js";

/**
 * Scope a dedicated API key must carry, and carry alone, to mint migration
 * assertions. It is distinct from `relayauth:assertion:create:relayhistory`,
 * so neither assertion key can reach the other endpoint.
 */
export const MIGRATION_ASSERTION_SCOPE = "relayauth:assertion:create:migration";
/** Creating or revoking a grant is API-key management for the caller's org. */
export const MIGRATION_GRANT_MANAGE_SCOPE = "relayauth:api-key:manage:*";
export const MIGRATION_ASSERTION_SUBJECT = "agent_relayhistory_migration";
export const MAX_MIGRATION_GRANT_TTL_SECONDS = 7 * 24 * 3600;
/** Mirrors the CHECK on migration_grants.allowed_users_json. */
export const MAX_MIGRATION_GRANT_USERS = 1000;

/**
 * Identity ids as RelayAuth and Cloud issue them. Bounded and free of
 * whitespace and JSON/URL metacharacters so an id can sit in a claim, an
 * audit row and a log line verbatim.
 */
const MIGRATION_USER_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/u;
const AUDIT_VALUE_MAX_LENGTH = 256;

export function isMigrationUserId(value: unknown): value is string {
  return typeof value === "string" && MIGRATION_USER_ID_SHAPE.test(value);
}

export function createMigrationGrantId(): string {
  return `mgr_${crypto.randomUUID().replace(/-/g, "")}`;
}

export type MigrationSourceUserRefusal = {
  ok: false;
  error: string;
  code:
    | "source_user_not_found"
    | "source_user_org_mismatch"
    | "source_user_not_human"
    | "source_user_inactive";
  status: 403;
};

/**
 * Fails closed: a migration may act only for a user RelayAuth itself knows as
 * an active human identity of `orgId`. There is no fallback to a grant's
 * allow-list for users RelayAuth has no identity for. Checked when a grant is
 * created (for every listed user) and again on every mint, so a user retired,
 * suspended, deleted or moved after the grant cannot be minted for.
 */
export async function checkMigrationSourceUser(
  storage: AuthStorage,
  orgId: string,
  userId: string,
): Promise<{ ok: true } | MigrationSourceUserRefusal> {
  const identity = await storage.identities.get(userId);
  if (!identity) {
    return {
      ok: false,
      error: "source user is not a RelayAuth identity",
      code: "source_user_not_found",
      status: 403,
    };
  }
  if (identity.orgId !== orgId) {
    return {
      ok: false,
      error: "source user belongs to another organization",
      code: "source_user_org_mismatch",
      status: 403,
    };
  }
  if (identity.type !== "human") {
    return {
      ok: false,
      error: "source user is not a human identity",
      code: "source_user_not_human",
      status: 403,
    };
  }
  if (identity.status !== "active") {
    return {
      ok: false,
      error: "source user is not active",
      code: "source_user_inactive",
      status: 403,
    };
  }
  return { ok: true };
}

/** Clamp caller-supplied text before it lands in an audit row. */
export function auditValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, AUDIT_VALUE_MAX_LENGTH) : undefined;
}

/** Drop absent values so audit metadata stays Record<string, string>. */
export function auditMetadata(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Records a refusal. The refusal itself is the security property, so a
 * failed audit write is logged and does not turn the refusal into a 500.
 */
export async function writeMigrationDenialAudit(
  storage: AuthStorage,
  entry: Omit<AuditLogWriteEntry, "id" | "result" | "plane" | "timestamp">,
): Promise<void> {
  try {
    await storage.audit.write({
      ...entry,
      id: crypto.randomUUID(),
      plane: "relayauth",
      result: "denied",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("RelayAuth migration denial audit failed", {
      action: entry.action,
      resource: entry.resource,
      error,
    });
  }
}
