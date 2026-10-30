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
export const MAX_MIGRATION_GRANT_TTL_SECONDS = 7 * 24 * 3600;

/** Maximum sanitized scalar length accepted into denial audit metadata. */
const AUDIT_VALUE_MAX_LENGTH = 256;

export function createMigrationGrantId(): string {
  return `mgr_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Request header carrying the caller-chosen key that makes grant creation
 * retry-safe. It is required on every create.
 */
export const MIGRATION_GRANT_IDEMPOTENCY_HEADER = "Idempotency-Key";
/** Header set on a response that returns an existing grant for a retry. */
export const MIGRATION_GRANT_REPLAYED_HEADER = "Idempotent-Replayed";
const IDEMPOTENCY_KEY_SHAPE = /^[A-Za-z0-9_-]{32,128}$/u;
/**
 * The shape check alone admits "aaaa...". Reject keys with too few distinct
 * characters; any random 32-character hex, base64url or UUIDv4 value clears
 * this by a wide margin.
 */
const IDEMPOTENCY_KEY_MIN_DISTINCT_CHARS = 8;
const IDEMPOTENCY_KEY_HASH_DOMAIN = "relayauth.migration_grant.idempotency_key.v1";

export type MigrationGrantIdempotencyKeyRefusal = {
  ok: false;
  error: string;
  code: "idempotency_key_required" | "invalid_idempotency_key";
  status: 400;
};

/**
 * Validates the raw Idempotency-Key. The returned key must only ever be fed to
 * migrationGrantIdempotencyKeyHash; it is never persisted, audited or logged,
 * and refusals never echo it.
 */
export function parseMigrationGrantIdempotencyKey(
  value: string | undefined,
): { ok: true; key: string } | MigrationGrantIdempotencyKeyRefusal {
  if (value === undefined || value.length === 0) {
    return {
      ok: false,
      error: `${MIGRATION_GRANT_IDEMPOTENCY_HEADER} header is required`,
      code: "idempotency_key_required",
      status: 400,
    };
  }
  if (
    !IDEMPOTENCY_KEY_SHAPE.test(value) ||
    new Set(value).size < IDEMPOTENCY_KEY_MIN_DISTINCT_CHARS
  ) {
    return {
      ok: false,
      error: `${MIGRATION_GRANT_IDEMPOTENCY_HEADER} must be 32 to 128 random characters of A-Za-z0-9_-`,
      code: "invalid_idempotency_key",
      status: 400,
    };
  }
  return { ok: true, key: value };
}

/**
 * Domain-separated SHA-256 over (org, caller, key). Binding the org and the
 * caller into the hash means the same raw key from another org or another
 * caller resolves to an unrelated receipt, i.e. is absent, without any
 * existence signal. The key is caller-chosen and high entropy, so a plain hash
 * is not invertible.
 */
export function migrationGrantIdempotencyKeyHash(input: {
  orgId: string;
  callerId: string;
  key: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        IDEMPOTENCY_KEY_HASH_DOMAIN,
        input.orgId,
        input.callerId,
        input.key,
      ]),
    )
    .digest("hex");
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
