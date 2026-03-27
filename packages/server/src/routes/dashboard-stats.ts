import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { requireScope } from "../middleware/scope.js";

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

type DashboardAuditCounts = Required<Pick<DashboardStatsResponse, "tokensIssued" | "tokensRevoked" | "tokensRefreshed" | "scopeChecks" | "scopeDenials">>;
type DashboardIdentityCounts = Required<Pick<DashboardStatsResponse, "activeIdentities" | "suspendedIdentities">>;

type DashboardStatsQuery = {
  from?: string;
  to?: string;
};

const dashboardStats = new Hono<AppEnv>();

dashboardStats.use("*", requireScope("relayauth:stats:read"));

dashboardStats.get("/", async (c) => {
  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const parsedQuery = parseDashboardStatsQuery(c.req.query());

  if (!parsedQuery.ok) {
    return c.json({ error: parsedQuery.error }, 400);
  }

  if (!claims?.org) {
    return c.json({ error: "missing_org_context" }, 401);
  }

  const storage = c.get("storage");
  const [auditCounts, identityCounts] = await Promise.all([
    storage.audit.getActionCounts(claims.org, parsedQuery.value),
    storage.identities.getStatusCounts(claims.org),
  ]);

  const response: DashboardStatsResponse = {
    tokensIssued: auditCounts.tokensIssued,
    tokensRevoked: auditCounts.tokensRevoked,
    scopeChecks: auditCounts.scopeChecks,
    scopeDenials: auditCounts.scopeDenials,
    activeIdentities: identityCounts.activeIdentities,
    suspendedIdentities: identityCounts.suspendedIdentities,
    ...(auditCounts.tokensRefreshed > 0 ? { tokensRefreshed: auditCounts.tokensRefreshed } : {}),
    ...(parsedQuery.value.from || parsedQuery.value.to
      ? {
          period: {
            from: parsedQuery.value.from ?? "",
            to: parsedQuery.value.to ?? "",
          },
        }
      : {}),
  };

  return c.json(response, 200);
});

function parseDashboardStatsQuery(
  query: Record<string, string | undefined>,
): { ok: true; value: DashboardStatsQuery } | { ok: false; error: string } {
  const from = normalizeQueryValue(query.from);
  if (from && !isIsoTimestamp(from)) {
    return { ok: false, error: "from must be an ISO 8601 timestamp" };
  }

  const to = normalizeQueryValue(query.to);
  if (to && !isIsoTimestamp(to)) {
    return { ok: false, error: "to must be an ISO 8601 timestamp" };
  }

  return {
    ok: true,
    value: {
      from,
      to,
    },
  };
}

function summarizeAuditCounts(rows: DashboardAuditCountRow[]): DashboardAuditCounts {
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

function summarizeIdentityCounts(rows: DashboardIdentityCountRow[]): DashboardIdentityCounts {
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

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

export default dashboardStats;
