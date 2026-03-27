import type {
  AgentIdentity,
  CreateIdentityInput,
  IdentityStatus,
  IdentityType,
} from "@relayauth/types";
import { matchScope } from "@relayauth/sdk";
import { Hono } from "hono";
import type { IdentityBudget, StoredIdentity } from "../durable-objects/identity-do.js";
import type { AppEnv } from "../env.js";
import { authenticateAndAuthorize, decodeBase64UrlJson } from "../lib/auth.js";

type CreateIdentityRequest = CreateIdentityInput & {
  sponsorId?: string;
  budget?: IdentityBudget;
};

type UpdateIdentityRequest = Partial<StoredIdentity>;

type SuspendIdentityRequest = {
  reason?: string;
};

type RetireIdentityRequest = {
  reason?: string;
};

type DuplicateIdentityRow = {
  id?: string;
  name?: string;
  orgId?: string;
  org_id?: string;
  count?: number;
  exists?: number;
};

type OrgBudgetRow = {
  budget?: IdentityBudget;
  budget_json?: string;
  defaultBudget?: IdentityBudget;
  default_budget?: string;
  data?: string;
  settings_json?: string;
};

type ChildIdentityRow = {
  id?: string;
};

type ActiveTokenRow = {
  id?: string;
  jti?: string;
  tokenId?: string;
  token_id?: string;
};

type ListIdentityRow = {
  id?: string;
  name?: string;
  type?: string;
  orgId?: string;
  org_id?: string;
  status?: string;
  scopes?: string | string[];
  scopes_json?: string;
  roles?: string | string[];
  roles_json?: string;
  metadata?: string | Record<string, string>;
  metadata_json?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  lastActiveAt?: string;
  last_active_at?: string;
  suspendedAt?: string;
  suspended_at?: string;
  suspendReason?: string;
  suspend_reason?: string;
};

const identities = new Hono<AppEnv>();

const DUPLICATE_NAME_SQL = `
  SELECT id, name, org_id AS orgId
  FROM identities
  WHERE org_id = ? AND name = ?
  LIMIT 1
`;

const ORG_BUDGET_SQL = `
  SELECT budget, budget_json, default_budget, settings_json, data
  FROM org_budgets
  WHERE org_id = ?
  LIMIT 1
`;

const CHILD_IDENTITIES_SQL = `
  SELECT id
  FROM identities
  WHERE org_id = ? AND sponsor_id = ?
  ORDER BY created_at DESC, id DESC
`;

const ACTIVE_TOKENS_SQL = `
  SELECT id, jti, token_id AS tokenId
  FROM tokens
  WHERE identity_id = ? AND status = 'active'
`;

const INSERT_AUDIT_EVENT_SQL = `
  INSERT INTO audit_events (
    id,
    org_id,
    workspace_id,
    identity_id,
    action,
    reason,
    payload,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

identities.get("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const status = normalizeIdentityStatus(c.req.query("status"));
  const type = parseIdentityTypeFilter(c.req.query("type"));
  const limit = parseIdentityListLimit(c.req.query("limit"));
  const cursorId = decodeIdentityCursor(c.req.query("cursor"));

  const query = buildListIdentitiesQuery(auth.claims.org, status, type, limit, cursorId);
  const result = await c.env.DB.prepare(query.sql).bind(...query.params).all<ListIdentityRow>();
  const rows = (result.results ?? [])
    .map(hydrateListIdentity)
    .filter((identity): identity is AgentIdentity => identity !== null);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json(
    {
      data: page,
      ...(hasMore && page.length > 0 ? { cursor: encodeIdentityCursor(page[page.length - 1].id) } : {}),
    },
    200,
  );
});

identities.get("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const durableObjectId = c.env.IDENTITY_DO.idFromName(id);
  const durableObject = c.env.IDENTITY_DO.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/get", {
      method: "GET",
    }),
  );

  if (response.status === 404) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    return c.json({ error: message || "Failed to fetch identity" }, response.status as 400 | 401 | 403 | 500);
  }

  const identity = await response.json<StoredIdentity>();
  if (identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  return c.json(identity, 200);
});

identities.patch("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const existing = await getStoredIdentity(c.env.IDENTITY_DO, id);
  if (!existing.ok) {
    return c.json({ error: existing.error }, existing.status);
  }
  if (existing.identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const body = await c.req.json<UpdateIdentityRequest>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const update = sanitizeIdentityUpdate(body);
  if (Object.keys(update).length === 0) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const durableObjectId = c.env.IDENTITY_DO.idFromName(id);
  const durableObject = c.env.IDENTITY_DO.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/update", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(update),
    }),
  );

  if (response.status === 404) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    return c.json({ error: message || "Failed to update identity" }, response.status as 400 | 401 | 403 | 500);
  }

  const identity = await response.json<StoredIdentity>();
  return c.json(identity, 200);
});

identities.delete("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  if (c.req.header("x-confirm-delete") !== "true") {
    return c.json({ error: "X-Confirm-Delete: true header is required" }, 400);
  }

  const id = c.req.param("id").trim();
  const existing = await getStoredIdentity(c.env.IDENTITY_DO, id);
  if (!existing.ok) {
    return c.json({ error: existing.error }, existing.status);
  }
  if (existing.identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const activeTokenIds = await listActiveTokenIds(c.env.DB, existing.identity.id);
  const deleted = await deleteStoredIdentity(c.env.IDENTITY_DO, existing.identity.id);
  if (!deleted.ok) {
    return c.json({ error: deleted.error }, deleted.status);
  }

  await revokeIdentityTokens(c.env.REVOCATION_KV, existing.identity.id, activeTokenIds, new Date().toISOString());
  return c.body(null, 204);
});

identities.post("/:id/suspend", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const preCheck = await getStoredIdentity(c.env.IDENTITY_DO, id);
  if (!preCheck.ok) {
    return c.json({ error: preCheck.error }, preCheck.status);
  }
  if (preCheck.identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const body = await c.req.json<SuspendIdentityRequest>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return c.json({ error: "reason is required" }, 400);
  }

  const suspended = await suspendIdentity(c.env.IDENTITY_DO, id, reason);
  if (!suspended.ok) {
    return c.json({ error: suspended.error }, suspended.status);
  }

  const activeTokenIds = await listActiveTokenIds(c.env.DB, suspended.identity.id);
  await revokeIdentityTokens(c.env.REVOCATION_KV, suspended.identity.id, activeTokenIds, suspended.identity.updatedAt);

  const childIdentityIds = await listChildIdentityIds(c.env.DB, suspended.identity.orgId, suspended.identity.id);
  for (const childIdentityId of childIdentityIds) {
    const childSuspended = await suspendIdentity(c.env.IDENTITY_DO, childIdentityId, "parent_suspended");
    if (!childSuspended.ok) {
      if (childSuspended.status === 404 || childSuspended.status === 409) {
        continue;
      }

      return c.json({ error: childSuspended.error }, childSuspended.status);
    }

    const childActiveTokenIds = await listActiveTokenIds(c.env.DB, childSuspended.identity.id);
    await revokeIdentityTokens(c.env.REVOCATION_KV, childSuspended.identity.id, childActiveTokenIds, childSuspended.identity.updatedAt);

    await writeIdentitySuspendedAuditEvent(c.env.DB, childSuspended.identity, "parent_suspended", auth.claims.sub);
  }

  await writeIdentitySuspendedAuditEvent(c.env.DB, suspended.identity, reason, auth.claims.sub);
  return c.json(suspended.identity, 200);
});

identities.post("/:id/retire", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const preCheck = await getStoredIdentity(c.env.IDENTITY_DO, id);
  if (!preCheck.ok) {
    return c.json({ error: preCheck.error }, preCheck.status);
  }
  if (preCheck.identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const parsedBody = await parseOptionalJsonObjectBody<RetireIdentityRequest>(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const reason = typeof parsedBody.body?.reason === "string" ? parsedBody.body.reason.trim() : undefined;
  const retired = await retireIdentity(c.env.IDENTITY_DO, id, reason);
  if (!retired.ok) {
    return c.json({ error: retired.error }, retired.status);
  }

  const activeTokenIds = await listActiveTokenIds(c.env.DB, retired.identity.id);
  await revokeIdentityTokens(c.env.REVOCATION_KV, retired.identity.id, activeTokenIds, retired.identity.updatedAt);

  return c.json(retired.identity, 200);
});

identities.post("/:id/reactivate", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const preCheck = await getStoredIdentity(c.env.IDENTITY_DO, id);
  if (!preCheck.ok) {
    return c.json({ error: preCheck.error }, preCheck.status);
  }
  if (preCheck.identity.orgId !== auth.claims.org) {
    return c.json({ error: "identity_not_found" }, 404);
  }

  const reactivated = await reactivateIdentity(c.env.IDENTITY_DO, id);
  if (!reactivated.ok) {
    return c.json({ error: reactivated.error }, reactivated.status);
  }

  return c.json(reactivated.identity, 200);
});

identities.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:identity:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const body = await c.req.json<CreateIdentityRequest>().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const sponsorId = typeof body.sponsorId === "string" ? body.sponsorId.trim() : "";
  if (!sponsorId) {
    return c.json({ error: "sponsorId is required" }, 400);
  }

  const duplicate = await findDuplicateIdentity(c.env.DB, auth.claims.org, name);
  if (duplicate) {
    return c.json({ error: "identity_already_exists" }, 409);
  }

  const timestamp = new Date().toISOString();
  const id = createIdentityId();
  const budget = body.budget ?? (await loadOrgBudget(c.env.DB, auth.claims.org));
  const storedIdentity: StoredIdentity = {
    id,
    name,
    type: normalizeIdentityType(body.type),
    orgId: auth.claims.org,
    status: "active",
    scopes: normalizeStringList(body.scopes),
    roles: normalizeStringList(body.roles),
    metadata: normalizeMetadata(body.metadata),
    createdAt: timestamp,
    updatedAt: timestamp,
    sponsorId,
    sponsorChain: [...auth.claims.sponsorChain, auth.claims.sub],
    workspaceId: normalizeWorkspaceId(body.workspaceId, auth.claims.wks),
    ...(budget ? { budget } : {}),
  };

  const durableObjectId = c.env.IDENTITY_DO.idFromName(storedIdentity.id);
  const durableObject = c.env.IDENTITY_DO.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(storedIdentity),
    }),
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    return c.json({ error: message || "Failed to create identity" }, response.status as 400 | 409 | 500);
  }

  const createdIdentity = await response.json<StoredIdentity>();
  return c.json(createdIdentity, 201);
});

function normalizeIdentityType(type: IdentityType | undefined): IdentityType {
  return type === "human" || type === "service" ? type : "agent";
}

function normalizeIdentityStatus(status: string | undefined): IdentityStatus | undefined {
  return status === "active" || status === "suspended" || status === "retired" ? status : undefined;
}

function parseIdentityTypeFilter(type: string | undefined): IdentityType | undefined {
  return type === "agent" || type === "human" || type === "service" ? type : undefined;
}

function parseIdentityListLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 50;
  }

  return Math.min(parsed, 100);
}

function buildListIdentitiesQuery(
  orgId: string,
  status: IdentityStatus | undefined,
  type: IdentityType | undefined,
  limit: number,
  cursorId: string | undefined,
): { sql: string; params: (string | number)[] } {
  const clauses = ["org_id = ?"];
  const params: (string | number)[] = [orgId];

  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }

  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }

  if (cursorId) {
    clauses.push("(created_at, id) < (SELECT created_at, id FROM identities WHERE id = ?)");
    params.push(cursorId);
  }

  // Fetch limit + 1 to detect whether more pages exist
  params.push(limit + 1);

  return {
    sql: `
      SELECT *
      FROM identities
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    params,
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  );
}

function normalizeWorkspaceId(workspaceId: string | undefined, fallback: string): string {
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : fallback;
}

function sanitizeIdentityUpdate(body: UpdateIdentityRequest): UpdateIdentityRequest {
  const update: UpdateIdentityRequest = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name) {
      update.name = name;
    }
  }

  if (body.type && parseIdentityTypeFilter(body.type)) {
    update.type = body.type;
  }

  // status, sponsorId, sponsorChain, workspaceId are not allowed via PATCH —
  // use dedicated endpoints (suspend, retire, reactivate) for status changes.

  if ("scopes" in body) {
    update.scopes = normalizeStringList(body.scopes);
  }

  if ("roles" in body) {
    update.roles = normalizeStringList(body.roles);
  }

  if ("metadata" in body) {
    update.metadata = normalizeMetadata(body.metadata);
  }

  if (typeof body.lastActiveAt === "string") {
    update.lastActiveAt = body.lastActiveAt;
  }

  if (isIdentityBudget(body.budget)) {
    update.budget = body.budget;
  }

  if (isIdentityBudgetUsage(body.budgetUsage)) {
    update.budgetUsage = body.budgetUsage;
  }

  return update;
}

function hydrateListIdentity(row: ListIdentityRow): AgentIdentity | null {
  const id = typeof row.id === "string" ? row.id : undefined;
  const name = typeof row.name === "string" ? row.name : undefined;
  const orgId =
    typeof row.orgId === "string"
      ? row.orgId
      : typeof row.org_id === "string"
        ? row.org_id
        : undefined;
  const createdAt =
    typeof row.createdAt === "string"
      ? row.createdAt
      : typeof row.created_at === "string"
        ? row.created_at
        : undefined;
  const updatedAt =
    typeof row.updatedAt === "string"
      ? row.updatedAt
      : typeof row.updated_at === "string"
        ? row.updated_at
        : undefined;

  if (!id || !name || !orgId || !createdAt || !updatedAt) {
    return null;
  }

  const status = normalizeIdentityStatus(row.status) ?? "active";
  const scopes = parseStringListColumn(row.scopes_json ?? row.scopes);
  const roles = parseStringListColumn(row.roles_json ?? row.roles);
  const metadata = parseMetadataColumn(row.metadata_json ?? row.metadata);

  return {
    id,
    name,
    type: normalizeIdentityType(parseIdentityTypeFilter(row.type)),
    orgId,
    status,
    scopes,
    roles,
    metadata,
    createdAt,
    updatedAt,
    ...(typeof row.lastActiveAt === "string"
      ? { lastActiveAt: row.lastActiveAt }
      : typeof row.last_active_at === "string"
        ? { lastActiveAt: row.last_active_at }
        : {}),
    ...(typeof row.suspendedAt === "string"
      ? { suspendedAt: row.suspendedAt }
      : typeof row.suspended_at === "string"
        ? { suspendedAt: row.suspended_at }
        : {}),
    ...(typeof row.suspendReason === "string"
      ? { suspendReason: row.suspendReason }
      : typeof row.suspend_reason === "string"
        ? { suspendReason: row.suspend_reason }
        : {}),
  };
}

function parseStringListColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeStringList(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    return normalizeStringList(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function parseMetadataColumn(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeMetadata(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    return normalizeMetadata(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}


function createIdentityId(): string {
  return `agent_${crypto.randomUUID().replace(/-/g, "")}`;
}

function encodeIdentityCursor(id: string): string {
  return btoa(JSON.stringify({ id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeIdentityCursor(cursor: string | undefined): string | undefined {
  const trimmed = cursor?.trim();
  if (!trimmed) {
    return undefined;
  }

  const decoded = decodeBase64UrlJson<{ id?: unknown }>(trimmed);
  if (typeof decoded?.id === "string" && decoded.id) {
    return decoded.id;
  }

  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : trimmed;
  } catch {
    return trimmed;
  }
}

async function findDuplicateIdentity(
  db: D1Database,
  orgId: string,
  name: string,
): Promise<DuplicateIdentityRow | null> {
  return db.prepare(DUPLICATE_NAME_SQL).bind(orgId, name).first<DuplicateIdentityRow>();
}

async function parseOptionalJsonObjectBody<T extends object>(
  request: Request,
): Promise<
  | { ok: true; body?: T }
  | { ok: false }
> {
  const rawBody = await request.clone().text().catch(() => "");
  if (!rawBody.trim()) {
    return { ok: true };
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false };
    }

    return { ok: true, body: parsed as T };
  } catch {
    return { ok: false };
  }
}

async function getStoredIdentity(
  identityNamespace: DurableObjectNamespace,
  identityId: string,
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 }
> {
  const durableObjectId = identityNamespace.idFromName(identityId);
  const durableObject = identityNamespace.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/get", {
      method: "GET",
    }),
  );

  if (response.ok) {
    return {
      ok: true,
      identity: await response.json<StoredIdentity>(),
    };
  }

  return {
    ok: false,
    error: (await readResponseError(response, "Failed to fetch identity")) ?? "Failed to fetch identity",
    status: response.status as 400 | 401 | 403 | 404 | 500,
  };
}

async function deleteStoredIdentity(
  identityNamespace: DurableObjectNamespace,
  identityId: string,
): Promise<
  | { ok: true }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 500 }
> {
  const durableObjectId = identityNamespace.idFromName(identityId);
  const durableObject = identityNamespace.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/delete", {
      method: "DELETE",
    }),
  );

  if (response.ok) {
    return {
      ok: true,
    };
  }

  return {
    ok: false,
    error: (await readResponseError(response, "Failed to delete identity")) ?? "Failed to delete identity",
    status: response.status as 400 | 401 | 403 | 404 | 500,
  };
}

async function suspendIdentity(
  identityNamespace: DurableObjectNamespace,
  identityId: string,
  reason: string,
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 409 | 500 }
> {
  const durableObjectId = identityNamespace.idFromName(identityId);
  const durableObject = identityNamespace.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/suspend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason }),
    }),
  );

  if (response.ok) {
    return {
      ok: true,
      identity: await response.json<StoredIdentity>(),
    };
  }

  return {
    ok: false,
    error: (await readResponseError(response, "Failed to suspend identity")) ?? "Failed to suspend identity",
    status: response.status as 400 | 401 | 403 | 404 | 409 | 500,
  };
}

async function retireIdentity(
  identityNamespace: DurableObjectNamespace,
  identityId: string,
  reason: string | undefined,
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 409 | 500 }
> {
  const durableObjectId = identityNamespace.idFromName(identityId);
  const durableObject = identityNamespace.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/retire", {
      method: "POST",
      ...(reason
        ? {
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ reason }),
          }
        : {}),
    }),
  );

  if (response.ok) {
    return {
      ok: true,
      identity: await response.json<StoredIdentity>(),
    };
  }

  return {
    ok: false,
    error: (await readResponseError(response, "Failed to retire identity")) ?? "Failed to retire identity",
    status: response.status as 400 | 401 | 403 | 404 | 409 | 500,
  };
}

async function reactivateIdentity(
  identityNamespace: DurableObjectNamespace,
  identityId: string,
): Promise<
  | { ok: true; identity: StoredIdentity }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 409 | 500 }
> {
  const durableObjectId = identityNamespace.idFromName(identityId);
  const durableObject = identityNamespace.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/reactivate", {
      method: "POST",
    }),
  );

  if (response.ok) {
    return {
      ok: true,
      identity: await response.json<StoredIdentity>(),
    };
  }

  return {
    ok: false,
    error: (await readResponseError(response, "Failed to reactivate identity")) ?? "Failed to reactivate identity",
    status: response.status as 400 | 401 | 403 | 404 | 409 | 500,
  };
}

async function listChildIdentityIds(db: D1Database, orgId: string, sponsorId: string): Promise<string[]> {
  const result = await db.prepare(CHILD_IDENTITIES_SQL).bind(orgId, sponsorId).all<ChildIdentityRow>();
  return Array.from(
    new Set(
      (result.results ?? [])
        .map((row) => (typeof row.id === "string" ? row.id.trim() : ""))
        .filter((id): id is string => id.length > 0 && id !== sponsorId),
    ),
  );
}

async function listActiveTokenIds(db: D1Database, identityId: string): Promise<string[]> {
  const result = await db.prepare(ACTIVE_TOKENS_SQL).bind(identityId).all<ActiveTokenRow>();
  return Array.from(
    new Set(
      (result.results ?? [])
        .map((row) => {
          if (typeof row.id === "string" && row.id.trim()) {
            return row.id.trim();
          }

          if (typeof row.jti === "string" && row.jti.trim()) {
            return row.jti.trim();
          }

          if (typeof row.tokenId === "string" && row.tokenId.trim()) {
            return row.tokenId.trim();
          }

          if (typeof row.token_id === "string" && row.token_id.trim()) {
            return row.token_id.trim();
          }

          return "";
        })
        .filter((tokenId): tokenId is string => tokenId.length > 0),
    ),
  );
}

async function revokeIdentityTokens(
  revocationKv: KVNamespace,
  identityId: string,
  tokenIds: string[],
  revokedAt: string,
): Promise<void> {
  await Promise.all(
    tokenIds.map((tokenId) =>
      revocationKv.put(
        `revoked:${tokenId}`,
        JSON.stringify({
          tokenId,
          identityId,
          revokedAt,
        }),
      ),
    ),
  );
}

async function writeIdentitySuspendedAuditEvent(
  db: D1Database,
  identity: StoredIdentity,
  reason: string,
  actorId: string,
): Promise<void> {
  const payload = JSON.stringify({
    eventType: "identity.suspended",
    status: identity.status,
    sponsorId: identity.sponsorId,
    sponsorChain: identity.sponsorChain,
    actorId,
    reason,
  });

  try {
    await db.prepare(INSERT_AUDIT_EVENT_SQL)
      .bind(
        crypto.randomUUID(),
        identity.orgId,
        identity.workspaceId,
        identity.id,
        "identity.suspended",
        reason,
        payload,
        identity.updatedAt,
      )
      .run();
  } catch (err) {
    console.error("Failed to write identity suspended audit event", err);
  }
}

async function loadOrgBudget(db: D1Database, orgId: string): Promise<IdentityBudget | undefined> {
  const row = await db.prepare(ORG_BUDGET_SQL).bind(orgId).first<OrgBudgetRow>();
  if (!row) {
    return undefined;
  }

  if (isIdentityBudget(row.budget)) {
    return row.budget;
  }

  if (isIdentityBudget(row.defaultBudget)) {
    return row.defaultBudget;
  }

  return (
    parseBudgetValue(row.budget_json) ??
    parseBudgetValue(row.default_budget) ??
    parseSettingsBudget(row.settings_json) ??
    parseBudgetValue(row.data)
  );
}

function parseSettingsBudget(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { budget?: unknown };
    return isIdentityBudget(parsed.budget) ? parsed.budget : undefined;
  } catch {
    return undefined;
  }
}

function parseBudgetValue(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isIdentityBudget(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isIdentityBudget(value: unknown): value is IdentityBudget {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIdentityBudgetUsage(value: unknown): value is StoredIdentity["budgetUsage"] {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.clone().json<{ error?: unknown }>();
    if (typeof body?.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall back to plain text below.
  }

  const text = await response.text().catch(() => "");
  return text || fallback;
}

export default identities;
