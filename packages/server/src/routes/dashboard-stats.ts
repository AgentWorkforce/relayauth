import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import {
  asStorageCapacitySqlExecutor,
  collectTableFootprint,
  evaluateStorageCapacity,
  logStorageCapacity,
  readStorageCapacitySample,
  resolveStorageCapacitySettings,
  resolveStorageSizeSample,
} from "../engine/storage-capacity.js";
import { requireScope } from "../middleware/scope.js";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  isIsoTimestamp,
} from "./audit-query.js";
import {
  createDashboardAuditContinuationFilterKey,
  normalizeAuditQueryTimestamp,
} from "../storage/interface.js";

type ScopeContextVars = {
  identity?: {
    org: string;
  };
};

type DashboardStatsResponse = {
  tokensIssued: number;
  tokensRevoked: number;
  tokensRefreshed?: number;
  scopeChecks: number;
  scopeDenials: number;
  activeIdentities: number;
  suspendedIdentities: number;
  period?: {
    from: string;
    to: string;
  };
  partial?: true;
  nextCursor?: string;
  hasMore?: true;
  workBudget?: {
    hotStorePages: number;
    hotStoreRows: number;
    archivePartitions: number;
    archiveReads: number;
  };
};

type DashboardAuditCountRow = {
  action?: string | null;
  count?: number | string | null;
  tokensIssued?: number | string | null;
  tokensRevoked?: number | string | null;
  tokensRefreshed?: number | string | null;
  scopeChecks?: number | string | null;
  scopeDenials?: number | string | null;
};

type DashboardIdentityCountRow = {
  status?: string | null;
  count?: number | string | null;
  activeIdentities?: number | string | null;
  suspendedIdentities?: number | string | null;
};

type DashboardAuditCounts = Required<
  Pick<
    DashboardStatsResponse,
    | "tokensIssued"
    | "tokensRevoked"
    | "tokensRefreshed"
    | "scopeChecks"
    | "scopeDenials"
  >
>;
type DashboardIdentityCounts = Required<
  Pick<DashboardStatsResponse, "activeIdentities" | "suspendedIdentities">
>;

type DashboardStatsQuery = {
  from?: string;
  to?: string;
  cursor?: {
    kind: "archive_partition";
    orgId: string;
    timestamp: string;
    inclusive?: boolean;
    chunk?: {
      key: string;
      sha256: string;
    };
    entryCursor?: {
      timestamp: string;
      id: string;
    };
    filterKey: string;
  };
};

const dashboardStats = new Hono<AppEnv>();

dashboardStats.use("*", requireScope("relayauth:stats:read"));

dashboardStats.get("/", async (c) => {
  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const parsedQuery = parseDashboardStatsQuery(c.req.query(), claims?.org);

  if (!parsedQuery.ok) {
    return c.json({ error: parsedQuery.error }, 400);
  }

  if (!claims?.org) {
    return c.json({ error: "missing_org_context" }, 401);
  }

  const storage = c.get("storage");
  const [auditResult, identityCounts] = await Promise.all([
    storage.audit.getActionCounts(claims.org, parsedQuery.value),
    storage.identities.getStatusCounts(claims.org),
  ]);

  const auditCounts = auditResult.counts;
  const nextCursor =
    auditResult.kind === "budget_exhausted"
      ? encodeAuditCursor(auditResult.continuation)
      : null;
  if (auditResult.kind === "budget_exhausted" && !nextCursor) {
    return c.json({ error: "invalid audit continuation" }, 500);
  }
  const response: DashboardStatsResponse = {
    tokensIssued: auditCounts.tokensIssued,
    tokensRevoked: auditCounts.tokensRevoked,
    scopeChecks: auditCounts.scopeChecks,
    scopeDenials: auditCounts.scopeDenials,
    activeIdentities: identityCounts.activeIdentities,
    suspendedIdentities: identityCounts.suspendedIdentities,
    ...(auditCounts.tokensRefreshed > 0
      ? { tokensRefreshed: auditCounts.tokensRefreshed }
      : {}),
    ...(parsedQuery.value.from || parsedQuery.value.to
      ? {
          period: {
            from: parsedQuery.value.from ?? "",
            to: parsedQuery.value.to ?? "",
          },
        }
      : {}),
    ...(auditResult.workBudget ? { workBudget: auditResult.workBudget } : {}),
    ...(auditResult.kind === "budget_exhausted"
      ? {
          partial: true as const,
          nextCursor: nextCursor!,
          hasMore: true as const,
        }
      : {}),
  };

  return c.json(response, 200);
});

// Tables worth naming in a capacity alert: the ones whose row counts have
// actually driven growth. Ordered by row count in the response, so the alert
// says what is filling the database rather than only that it is filling.
const CAPACITY_FOOTPRINT_TABLES = [
  "identities",
  "identity_lineages",
  "identity_lineage_members",
  "tokens",
  "token_lineages",
  "token_lineage_members",
  "audit_logs",
] as const;

/**
 * Reports storage headroom.
 *
 * Deliberately org-agnostic: the database is shared, and the ceiling that
 * matters is the whole file's. It is mounted behind the same
 * `relayauth:stats:read` scope as the rest of this router.
 *
 * The size comes from whichever source the deployment has. A recorded sample
 * (written by whatever sweep observes the backend's own reported size) wins; a
 * pragma probe fills in for stores that expose one. When neither answers, the
 * endpoint says so rather than reporting a fabricated zero.
 */
dashboardStats.get("/storage", async (c) => {
  const settings = resolveStorageCapacitySettings(c.env);
  const db = asStorageCapacitySqlExecutor(
    (c.get("storage") as unknown as { DB?: unknown }).DB,
  );

  const persisted = db ? await readStorageCapacitySample(db).catch(() => null) : null;
  const sample = await resolveStorageSizeSample(db, {
    ...(persisted ? { sizeBytes: persisted.sizeBytes } : {}),
    ...(persisted?.freelistBytes === undefined
      ? {}
      : { freelistBytes: persisted.freelistBytes }),
  });

  if (sample.sizeBytes === null) {
    return c.json(
      {
        sizeBytes: null,
        source: sample.source,
        capacityConfigured: settings.capacityBytes !== undefined,
        sheddingEnabled: settings.shedRatio !== undefined,
      },
      200,
    );
  }

  const capacityBytes = settings.capacityBytes ?? persisted?.capacityBytes;
  const assessment = capacityBytes
    ? evaluateStorageCapacity({
        sizeBytes: sample.sizeBytes,
        capacityBytes,
        warnRatio: settings.warnRatio,
        criticalRatio: settings.criticalRatio,
        ...(sample.freelistBytes === undefined
          ? {}
          : { freelistBytes: sample.freelistBytes }),
      })
    : null;

  if (assessment) {
    logStorageCapacity(assessment, { requestId: c.get("requestId"), via: "stats" });
  }

  return c.json(
    {
      sizeBytes: sample.sizeBytes,
      source: sample.source,
      ...(sample.freelistBytes === undefined
        ? {}
        : { freelistBytes: sample.freelistBytes }),
      ...(persisted ? { observedAt: persisted.observedAt } : {}),
      capacityConfigured: capacityBytes !== undefined,
      sheddingEnabled: settings.shedRatio !== undefined,
      ...(assessment
        ? {
            level: assessment.level,
            capacityBytes: assessment.capacityBytes,
            usedRatio: assessment.usedRatio,
            effectiveUsedRatio: assessment.effectiveUsedRatio,
            headroomBytes: assessment.headroomBytes,
            reclaimableBytes: assessment.reclaimableBytes,
            warnRatio: assessment.warnRatio,
            criticalRatio: assessment.criticalRatio,
          }
        : {}),
      ...(db
        ? { tables: await collectTableFootprint(db, CAPACITY_FOOTPRINT_TABLES) }
        : {}),
    },
    200,
  );
});

function parseDashboardStatsQuery(
  query: Record<string, string | undefined>,
  authenticatedOrgId: string | undefined,
): { ok: true; value: DashboardStatsQuery } | { ok: false; error: string } {
  const rawFrom = normalizeQueryValue(query.from);
  if (rawFrom && !isIsoTimestamp(rawFrom)) {
    return { ok: false, error: "from must be an ISO 8601 timestamp" };
  }
  const from = normalizeAuditQueryTimestamp(rawFrom, "from");

  const rawTo = normalizeQueryValue(query.to);
  if (rawTo && !isIsoTimestamp(rawTo)) {
    return { ok: false, error: "to must be an ISO 8601 timestamp" };
  }
  const to = normalizeAuditQueryTimestamp(rawTo, "to");

  const cursorValue = normalizeQueryValue(query.cursor);
  const decodedCursor = cursorValue
    ? decodeAuditCursor(cursorValue)
    : undefined;
  if (
    cursorValue &&
    (!decodedCursor ||
      decodedCursor.kind !== "archive_partition" ||
      decodedCursor.entryCursor)
  ) {
    return { ok: false, error: "invalid cursor" };
  }
  if (
    decodedCursor?.kind === "archive_partition" &&
    (decodedCursor.orgId !== authenticatedOrgId ||
      decodedCursor.filterKey !==
        createDashboardAuditContinuationFilterKey({ from, to }))
  ) {
    return { ok: false, error: "invalid cursor" };
  }

  return {
    ok: true,
    value: {
      from,
      to,
      cursor:
        decodedCursor?.kind === "archive_partition" ? decodedCursor : undefined,
    },
  };
}

function summarizeAuditCounts(
  rows: DashboardAuditCountRow[],
): DashboardAuditCounts {
  const counts: DashboardAuditCounts = {
    tokensIssued: 0,
    tokensRevoked: 0,
    tokensRefreshed: 0,
    scopeChecks: 0,
    scopeDenials: 0,
  };

  for (const row of rows) {
    if (hasAggregateAuditShape(row)) {
      counts.tokensIssued += toCount(row.tokensIssued);
      counts.tokensRevoked += toCount(row.tokensRevoked);
      counts.tokensRefreshed += toCount(row.tokensRefreshed);
      counts.scopeChecks += toCount(row.scopeChecks);
      counts.scopeDenials += toCount(row.scopeDenials);
      continue;
    }

    const action = typeof row.action === "string" ? row.action : null;
    if (!action) {
      continue;
    }

    const count = toCount(row.count);
    if (action === "token.issued") {
      counts.tokensIssued += count;
    } else if (action === "token.revoked") {
      counts.tokensRevoked += count;
    } else if (action === "token.refreshed") {
      counts.tokensRefreshed += count;
    } else if (action === "scope.checked") {
      counts.scopeChecks += count;
    } else if (action === "scope.denied") {
      counts.scopeDenials += count;
    }
  }

  return counts;
}

function summarizeIdentityCounts(
  rows: DashboardIdentityCountRow[],
): DashboardIdentityCounts {
  const counts: DashboardIdentityCounts = {
    activeIdentities: 0,
    suspendedIdentities: 0,
  };

  for (const row of rows) {
    if (hasAggregateIdentityShape(row)) {
      counts.activeIdentities += toCount(row.activeIdentities);
      counts.suspendedIdentities += toCount(row.suspendedIdentities);
      continue;
    }

    const status = typeof row.status === "string" ? row.status : null;
    if (!status) {
      continue;
    }

    const count = toCount(row.count);
    if (status === "active") {
      counts.activeIdentities += count;
    } else if (status === "suspended") {
      counts.suspendedIdentities += count;
    }
  }

  return counts;
}

function hasAggregateAuditShape(row: DashboardAuditCountRow): boolean {
  return (
    "tokensIssued" in row ||
    "tokensRevoked" in row ||
    "tokensRefreshed" in row ||
    "scopeChecks" in row ||
    "scopeDenials" in row
  );
}

function hasAggregateIdentityShape(row: DashboardIdentityCountRow): boolean {
  return "activeIdentities" in row || "suspendedIdentities" in row;
}

function toCount(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeQueryValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default dashboardStats;
