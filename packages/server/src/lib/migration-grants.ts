import crypto from "node:crypto";

import type { AuditLogWriteEntry, AuthStorage } from "../storage/index.js";
import { canonicalMigrationId } from "./migration-plan.js";

/**
 * Scope a dedicated API key must carry, and carry alone, to mint migration
 * assertions. It is distinct from `relayauth:assertion:create:relayhistory`,
 * so neither assertion key can reach the other endpoint.
 */
export const MIGRATION_ASSERTION_SCOPE = "relayauth:assertion:create:migration";
/** Creating or revoking a grant is API-key management for the caller's org. */
export const MIGRATION_GRANT_MANAGE_SCOPE = "relayauth:api-key:manage:*";
export const MIGRATION_ASSERTION_SUBJECT = "agent_relayhistory_migration";

/**
 * PROTOTYPE (96BullSessions #86 is on contract-review HOLD; these values
 * follow the review's direction and are not final). The base-read
 * capability is a separate token class from the upload assertion: its own
 * subject, audience, scope, tokenClass, TTL and jti namespace, so no verifier
 * or route that admits an upload assertion can admit it, and vice versa.
 */
export const MIGRATION_BASE_READ_SUBJECT = "agent_relayhistory_migration_base_read";
export const MIGRATION_BASE_READ_SCOPE = "rth:migration-base:read";
export const MIGRATION_BASE_READ_TOKEN_CLASS = "migration_base_read";
/** The one ingest route that admits it, appended to the grant's origin. */
export const MIGRATION_BASE_READ_ROUTE = "/v1/pipeline/manifests/base";
export const MAX_MIGRATION_BASE_READ_TTL_SECONDS = 30;
export const MIGRATION_BASE_READ_JTI_PREFIX = "mbr_";

export function migrationBaseReadAudience(grantAudience: string): string {
  return `${grantAudience}${MIGRATION_BASE_READ_ROUTE}`;
}
export const MAX_MIGRATION_GRANT_TTL_SECONDS = 7 * 24 * 3600;

/** Maximum sanitized scalar length accepted into denial audit metadata. */
const AUDIT_VALUE_MAX_LENGTH = 256;

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
    | "source_user_inactive"
    | "source_user_ambiguous";
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
  let canonicalUserId: string;
  let canonicalOrgId: string;
  try {
    canonicalUserId = canonicalMigrationId(userId, "source user id");
    canonicalOrgId = canonicalMigrationId(orgId, "organization id");
  } catch {
    return {
      ok: false,
      error: "source user is not a RelayAuth identity",
      code: "source_user_not_found",
      status: 403,
    };
  }
  // RelayAuth deployments historically stored either the canonical id or its
  // single `relay_` alias. Resolve both, but fail closed on an ambiguous store.
  const [canonicalIdentity, prefixedIdentity] = await Promise.all([
    storage.identities.get(canonicalUserId),
    storage.identities.get(`relay_${canonicalUserId}`),
  ]);
  if (
    canonicalIdentity &&
    prefixedIdentity &&
    canonicalIdentity.id !== prefixedIdentity.id
  ) {
    return {
      ok: false,
      error: "source user id has ambiguous RelayAuth aliases",
      code: "source_user_ambiguous",
      status: 403,
    };
  }
  const identity = canonicalIdentity ?? prefixedIdentity;
  if (!identity) {
    return {
      ok: false,
      error: "source user is not a RelayAuth identity",
      code: "source_user_not_found",
      status: 403,
    };
  }
  let identityOrgId: string;
  let identityId: string;
  try {
    identityOrgId = canonicalMigrationId(identity.orgId, "organization id");
    identityId = canonicalMigrationId(identity.id, "source user id");
  } catch {
    return {
      ok: false,
      error: "source user is not a RelayAuth identity",
      code: "source_user_not_found",
      status: 403,
    };
  }
  if (identityId !== canonicalUserId || identityOrgId !== canonicalOrgId) {
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
