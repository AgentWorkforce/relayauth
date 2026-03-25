export type OrgAuditRetentionConfig = {
  orgId: string;
  retentionDays: number;
};

type RetentionConfigRow = {
  org_id?: unknown;
  orgId?: unknown;
  retention_days?: unknown;
  retentionDays?: unknown;
};

const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;

export async function purgeExpiredEntries(
  db: D1Database,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<{ deletedCount: number }> {
  const normalizedRetentionDays = normalizeRetentionDays(retentionDays);
  const cutoff = createCutoffTimestamp(normalizedRetentionDays);
  const result = await db.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(cutoff).run();

  return {
    deletedCount: result.meta.changes ?? 0,
  };
}

export async function countExpiredEntries(
  db: D1Database,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<{ expiredCount: number }> {
  const normalizedRetentionDays = normalizeRetentionDays(retentionDays);
  const cutoff = createCutoffTimestamp(normalizedRetentionDays);
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE created_at < ?")
    .bind(cutoff)
    .first<{ count?: unknown; expiredCount?: unknown }>();

  return {
    expiredCount: readCount(row?.count ?? row?.expiredCount),
  };
}

export async function getRetentionConfig(
  db: D1Database,
  orgId: string,
): Promise<OrgAuditRetentionConfig> {
  const normalizedOrgId = validateOrgId(orgId);
  const row = await db
    .prepare("SELECT org_id, retention_days FROM audit_retention_config WHERE org_id = ?")
    .bind(normalizedOrgId)
    .first<RetentionConfigRow>();

  if (!row) {
    return {
      orgId: normalizedOrgId,
      retentionDays: DEFAULT_RETENTION_DAYS,
    };
  }

  return {
    orgId: readString(row.org_id ?? row.orgId, "orgId") ?? normalizedOrgId,
    retentionDays: normalizeRetentionDays(row.retention_days ?? row.retentionDays),
  };
}

export async function setRetentionConfig(
  db: D1Database,
  orgId: string,
  retentionDays: number,
): Promise<OrgAuditRetentionConfig> {
  const normalizedOrgId = validateOrgId(orgId);
  const normalizedRetentionDays = normalizeRetentionDays(retentionDays);

  await db
    .prepare(
      `
        INSERT INTO audit_retention_config (org_id, retention_days)
        VALUES (?, ?)
        ON CONFLICT(org_id) DO UPDATE
        SET retention_days = excluded.retention_days
      `,
    )
    .bind(normalizedOrgId, normalizedRetentionDays)
    .run();

  return {
    orgId: normalizedOrgId,
    retentionDays: normalizedRetentionDays,
  };
}

export { DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS };

function normalizeRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("retentionDays must be an integer");
  }

  const num = value;

  if (num < MIN_RETENTION_DAYS) {
    throw new Error(`retentionDays must be at least ${MIN_RETENTION_DAYS} days`);
  }

  if (num > MAX_RETENTION_DAYS) {
    throw new Error(`retentionDays must be at most ${MAX_RETENTION_DAYS} days`);
  }

  return num;
}

function createCutoffTimestamp(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function readCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function validateOrgId(value: string): string {
  return readString(value, "orgId");
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}
