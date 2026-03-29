import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { requireScope } from "../middleware/scope.js";
import type { StoredIdentity } from "../storage/identity-types.js";
import type { AuthStorage } from "../storage/index.js";
import {
  buildAuditQuery,
  parseAuditQuery,
  toAuditEntry,
  type AuditLogRow,
  type ScopeContextVars,
} from "./audit-query.js";

type IdentityActivityBudgetUsage = {
  actionsThisHour: number;
  costToday: number;
  percentOfBudget: number;
};

type IdentityActivitySubAgent = {
  id: string;
  name: string;
  status: StoredIdentity["status"];
  children: IdentityActivitySubAgent[];
};

type IdentityTreeRow = {
  id?: string;
  name?: string;
  status?: string;
  sponsorId?: string;
  sponsor_id?: string;
  createdAt?: string;
  created_at?: string;
};

type HydratedSubAgent = {
  id: string;
  name: string;
  status: StoredIdentity["status"];
  sponsorId?: string;
  createdAt?: string;
};

const identityActivity = new Hono<AppEnv>();

const SUB_AGENT_QUERY_SQL = `
  SELECT id, name, status, sponsor_id, created_at
  FROM identities
  WHERE org_id = ? AND sponsor_id = ?
  ORDER BY created_at DESC, id DESC
`;

identityActivity.get("/:id/activity", requireScope("relayauth:audit:read"), async (c) => {
  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const identityId = c.req.param("id").trim();
  const storage = c.get("storage");

  const storedIdentity = await getStoredIdentity(storage, identityId);
  if (!storedIdentity.ok) {
    return c.json({ error: storedIdentity.error }, storedIdentity.status);
  }

  if (storedIdentity.identity.orgId !== claims?.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const parsed = parseAuditQuery(
    {
      ...c.req.query(),
      orgId: claims.org,
      identityId,
    },
    claims.org,
  );

  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const entries = await storage.audit.query(parsed.value);
  const hasMore = entries.length > parsed.value.limit;
  const page = hasMore ? entries.slice(0, parsed.value.limit) : entries;

  return c.json(
    {
      entries: page,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      hasMore,
      sponsorChain: storedIdentity.identity.sponsorChain,
      budgetUsage: summarizeBudgetUsage(storedIdentity.identity),
      subAgents: await listSubAgentTree(storage, storedIdentity.identity.orgId, storedIdentity.identity.id),
    },
    200,
  );
});

async function getStoredIdentity(
  storage: AuthStorage,
  identityId: string,
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 }
> {
  try {
    const identity = await storage.identities.get(identityId);
    if (!identity) {
      return {
        ok: false,
        error: "identity_not_found",
        status: 404,
      };
    }

    return {
      ok: true,
      identity,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch identity";
    return {
      ok: false,
      error: message,
      status: 500,
    };
  }
}

async function listSubAgentTree(
  storage: AuthStorage,
  orgId: string,
  sponsorId: string,
  visited = new Set<string>(),
): Promise<IdentityActivitySubAgent[]> {
  const children = (await storage.identities.listChildren(orgId, sponsorId))
    .map((entry) => ({
      ...entry,
    }))
    .sort(compareSubAgents);

  const tree: IdentityActivitySubAgent[] = [];

  for (const child of children) {
    if (visited.has(child.id)) {
      continue;
    }

    visited.add(child.id);
    tree.push({
      id: child.id,
      name: child.name,
      status: child.status,
      children: await listSubAgentTree(storage, orgId, child.id, visited),
    });
  }

  return tree;
}

function hydrateSubAgent(row: IdentityTreeRow): HydratedSubAgent | null {
  const id = typeof row.id === "string" ? row.id : undefined;
  const name = typeof row.name === "string" ? row.name : undefined;

  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    status: normalizeIdentityStatus(row.status),
    sponsorId:
      typeof row.sponsorId === "string"
        ? row.sponsorId
        : typeof row.sponsor_id === "string"
          ? row.sponsor_id
          : undefined,
    createdAt:
      typeof row.createdAt === "string"
        ? row.createdAt
        : typeof row.created_at === "string"
          ? row.created_at
          : undefined,
  };
}

function compareSubAgents(left: HydratedSubAgent, right: HydratedSubAgent): number {
  const leftCreatedAt = left.createdAt ?? "";
  const rightCreatedAt = right.createdAt ?? "";

  return rightCreatedAt.localeCompare(leftCreatedAt) || right.id.localeCompare(left.id);
}

function normalizeIdentityStatus(status: string | undefined): StoredIdentity["status"] {
  return status === "suspended" || status === "retired" ? status : "active";
}

function summarizeBudgetUsage(identity: StoredIdentity): IdentityActivityBudgetUsage {
  const actionsThisHour = identity.budgetUsage?.actionsThisHour ?? 0;
  const costToday = identity.budgetUsage?.costToday ?? 0;
  const percentages: number[] = [];

  if (typeof identity.budget?.maxActionsPerHour === "number" && identity.budget.maxActionsPerHour > 0) {
    percentages.push((actionsThisHour / identity.budget.maxActionsPerHour) * 100);
  }

  if (typeof identity.budget?.maxCostPerDay === "number" && identity.budget.maxCostPerDay > 0) {
    percentages.push((costToday / identity.budget.maxCostPerDay) * 100);
  }

  return {
    actionsThisHour,
    costToday,
    percentOfBudget: percentages.length > 0 ? Number(Math.max(...percentages).toFixed(2)) : 0,
  };
}

function encodeCursor(row: { timestamp?: string; id?: string } | undefined): string | null {
  if (!row?.timestamp || !row.id) {
    return null;
  }

  return btoa(`${row.timestamp}|${row.id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export default identityActivity;
