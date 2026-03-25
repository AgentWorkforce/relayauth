import type { Policy, Role } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk/src/scope-parser.js";

import type { StoredIdentity as BaseStoredIdentity } from "../durable-objects/identity-do.js";

type StoredIdentity = Omit<BaseStoredIdentity, "workspaceId"> & { workspaceId?: string };
import { applyPolicies, evaluateCondition } from "./policy-evaluation.js";
import { listPolicies } from "./policies.js";
import { listIdentityRoles } from "./role-assignments.js";

type IdentityRow = {
  id?: string;
  name?: string;
  type?: StoredIdentity["type"];
  orgId?: string;
  org_id?: string;
  status?: StoredIdentity["status"];
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
  metadata?: Record<string, string>;
  metadata_json?: string | Record<string, string>;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  sponsorId?: string;
  sponsor_id?: string;
  sponsorChain?: string[] | string;
  sponsor_chain?: string[] | string;
  sponsor_chain_json?: string | string[];
  workspaceId?: string;
  workspace_id?: string;
};

type OrganizationRow = {
  id?: string;
  orgId?: string;
  org_id?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
};

type WorkspaceRow = {
  id?: string;
  workspaceId?: string;
  workspace_id?: string;
  orgId?: string;
  org_id?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
};

type EvaluationContext = {
  identityId?: string;
  ip?: string;
  timestamp?: string;
  workspaceId?: string;
};

type OrganizationContext = {
  scopes: string[];
  roles: Role[];
};

type WorkspaceContext = {
  scopes: string[];
  roles: Role[];
};

type AgentContext = {
  scopes: string[];
  roles: Role[];
};

export type InheritanceChain = {
  org: {
    scopes: string[];
    roles: Role[];
    policies: Policy[];
  };
  workspace: {
    scopes: string[];
    roles: Role[];
    policies: Policy[];
  };
  agent: {
    scopes: string[];
    roles: Role[];
  };
  effective: string[];
};

const SELECT_IDENTITY_SQL = `
  SELECT
    id,
    name,
    type,
    org_id AS orgId,
    status,
    scopes,
    scopes_json,
    roles,
    roles_json,
    metadata,
    metadata_json,
    created_at AS createdAt,
    updated_at AS updatedAt,
    sponsor_id AS sponsorId,
    sponsor_chain AS sponsorChain,
    sponsor_chain_json,
    workspace_id AS workspaceId
  FROM identities
  WHERE id = ?
  LIMIT 1
`;

const SELECT_ORGANIZATION_SQL = `
  SELECT
    id,
    org_id AS orgId,
    scopes,
    scopes_json,
    roles,
    roles_json
  FROM organizations
  WHERE id = ?
  LIMIT 1
`;

const SELECT_WORKSPACE_SQL = `
  SELECT
    id,
    workspace_id AS workspaceId,
    org_id AS orgId,
    scopes,
    scopes_json,
    roles,
    roles_json
  FROM workspaces
  WHERE id = ?
  LIMIT 1
`;

export async function resolveInheritedScopes(
  db: D1Database,
  identityId: string,
): Promise<string[]> {
  const chain = await getInheritanceChain(db, identityId);
  return chain.effective;
}

export async function getInheritanceChain(
  db: D1Database,
  identityId: string,
): Promise<InheritanceChain> {
  const identity = await getIdentity(db, identityId);
  if (!identity || identity.status !== "active") {
    return emptyInheritanceChain();
  }

  const [orgContext, workspaceContext, agentContext, loadedPolicies] = await Promise.all([
    loadOrganizationContext(db, identity.orgId),
    identity.workspaceId
      ? loadWorkspaceContext(db, identity.workspaceId)
      : Promise.resolve({ scopes: [], roles: [] } as WorkspaceContext),
    loadAgentContext(db, identity),
    listPolicies(db, identity.orgId, identity.workspaceId),
  ]);

  const context = createEvaluationContext(identity);
  const orgPolicies = loadedPolicies.filter((policy) =>
    policy.workspaceId === undefined
    && policy.conditions.every((condition) => evaluateCondition(condition, context)),
  );
  const workspacePolicies = loadedPolicies.filter((policy) =>
    policy.workspaceId === identity.workspaceId
    && policy.conditions.every((condition) => evaluateCondition(condition, context)),
  );

  const orgEffective = applyDenyPolicies(orgContext.scopes, orgPolicies, context);

  const hasWorkspace = Boolean(identity.workspaceId);
  const workspaceBoundary = hasWorkspace
    ? intersectScopes(orgContext.scopes, workspaceContext.scopes)
    : [];
  const workspaceEffective = hasWorkspace
    ? applyDenyPolicies(
        workspaceBoundary,
        [...orgPolicies, ...workspacePolicies],
        context,
      )
    : [];
  const agentParentBoundary = hasWorkspace ? workspaceBoundary : orgContext.scopes;
  const agentBoundary = intersectScopes(agentParentBoundary, agentContext.scopes);
  const agentEffective = applyDenyPolicies(
    agentBoundary,
    [...orgPolicies, ...workspacePolicies],
    context,
  );

  return {
    org: {
      scopes: orgEffective,
      roles: orgContext.roles,
      policies: orgPolicies,
    },
    workspace: {
      scopes: workspaceEffective,
      roles: workspaceContext.roles,
      policies: workspacePolicies,
    },
    agent: {
      scopes: agentEffective,
      roles: agentContext.roles,
    },
    effective: applyDenyPolicies(
      dedupeScopes([
        ...orgEffective,
        ...workspaceEffective,
        ...agentEffective,
      ]),
      [...orgPolicies, ...workspacePolicies],
      context,
    ),
  };
}

async function getOrgScopes(db: D1Database, orgId: string): Promise<string[]> {
  const context = await loadOrganizationContext(db, orgId);
  return context.scopes;
}

async function getWorkspaceScopes(db: D1Database, workspaceId: string): Promise<string[]> {
  const context = await loadWorkspaceContext(db, workspaceId);
  return context.scopes;
}

async function getAgentScopes(db: D1Database, identityId: string): Promise<string[]> {
  const identity = await getIdentity(db, identityId);
  if (!identity) {
    return [];
  }
  const context = await loadAgentContext(db, identity);
  return context.scopes;
}

function intersectScopes(parentScopes: string[], childScopes: string[]): string[] {
  const narrowed: string[] = [];

  for (const childScope of dedupeScopes(childScopes)) {
    for (const parentScope of dedupeScopes(parentScopes)) {
      if (scopeMatches(childScope, parentScope)) {
        narrowed.push(childScope);
        continue;
      }

      if (scopeMatches(parentScope, childScope)) {
        narrowed.push(parentScope);
      }
    }
  }

  return dedupeScopes(narrowed);
}

async function loadOrganizationContext(
  db: D1Database,
  orgId: string,
): Promise<OrganizationContext> {
  const row = await db.prepare(SELECT_ORGANIZATION_SQL).bind(orgId.trim()).first<OrganizationRow>();
  if (!row) {
    return { scopes: [], roles: [] };
  }

  const roleIds = parseStringArrayColumn(row.roles_json ?? row.roles);
  const roles = await loadRolesByIds(db, roleIds);
  const scopes = dedupeScopes([
    ...parseStringArrayColumn(row.scopes_json ?? row.scopes),
    ...roles.flatMap((role) => role.scopes),
  ]);

  return { scopes, roles };
}

async function loadWorkspaceContext(
  db: D1Database,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const row = await db.prepare(SELECT_WORKSPACE_SQL).bind(workspaceId.trim()).first<WorkspaceRow>();
  if (!row) {
    return { scopes: [], roles: [] };
  }

  const roleIds = parseStringArrayColumn(row.roles_json ?? row.roles);
  const roles = await loadRolesByIds(db, roleIds);
  const scopes = dedupeScopes([
    ...parseStringArrayColumn(row.scopes_json ?? row.scopes),
    ...roles.flatMap((role) => role.scopes),
  ]);

  return { scopes, roles };
}

async function loadAgentContext(
  db: D1Database,
  identity: StoredIdentity,
): Promise<AgentContext> {
  const roles = await listIdentityRoles(db, identity.id);

  const scopes = dedupeScopes([
    ...identity.scopes,
    ...roles.flatMap((role) => role.scopes),
  ]);

  return { scopes, roles };
}

async function loadRolesByIds(db: D1Database, roleIds: string[]): Promise<Role[]> {
  const uniqueRoleIds = dedupeScopes(roleIds);
  if (uniqueRoleIds.length === 0) {
    return [];
  }

  const placeholders = uniqueRoleIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`
      SELECT
        id,
        name,
        description,
        scopes,
        scopes_json,
        org_id AS orgId,
        workspace_id AS workspaceId,
        built_in AS builtIn,
        created_at AS createdAt
      FROM roles
      WHERE id IN (${placeholders})
    `)
    .bind(...uniqueRoleIds)
    .all<{
      id?: string;
      name?: string;
      description?: string;
      scopes?: string | string[];
      scopes_json?: string | string[];
      orgId?: string;
      org_id?: string;
      workspaceId?: string | null;
      workspace_id?: string | null;
      builtIn?: boolean | number;
      built_in?: boolean | number;
      createdAt?: string;
      created_at?: string;
    }>();

  return (result.results ?? [])
    .map((row) => {
      const id = normalizeOptionalString(row.id);
      const name = normalizeOptionalString(row.name);
      const description = normalizeOptionalString(row.description);
      const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
      const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);

      if (!id || !name || !description || !orgId || !createdAt) {
        return null;
      }

      const scopes = parseStringArrayColumn(row.scopes_json ?? row.scopes);
      const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
      const builtIn = row.builtIn === true || row.builtIn === 1 || row.built_in === true || row.built_in === 1;

      return {
        id,
        name,
        description,
        scopes,
        orgId,
        ...(workspaceId ? { workspaceId } : {}),
        builtIn,
        createdAt,
      } as Role;
    })
    .filter((role): role is Role => role !== null);
}

async function getIdentity(
  db: D1Database,
  identityId: string,
): Promise<StoredIdentity | null> {
  const row = await db.prepare(SELECT_IDENTITY_SQL).bind(identityId.trim()).first<IdentityRow>();
  return hydrateIdentity(row);
}

function hydrateIdentity(row: IdentityRow | null): StoredIdentity | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const type = row.type;
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const status = row.status;
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  const updatedAt = normalizeOptionalString(row.updatedAt) ?? normalizeOptionalString(row.updated_at);
  const sponsorId = normalizeOptionalString(row.sponsorId) ?? normalizeOptionalString(row.sponsor_id);
  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);

  if (!id || !name || !type || !orgId || !status || !createdAt || !updatedAt || !sponsorId) {
    return null;
  }

  const metadata = parseRecordColumn(row.metadata_json ?? row.metadata);
  const sponsorChain = parseStringArrayColumn(
    row.sponsor_chain_json ?? row.sponsorChain ?? row.sponsor_chain,
  );

  return {
    id,
    name,
    type,
    orgId,
    status,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
    metadata,
    createdAt,
    updatedAt,
    sponsorId,
    sponsorChain: sponsorChain.length > 0 ? sponsorChain : [sponsorId, id],
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function createEvaluationContext(identity: StoredIdentity): EvaluationContext {
  return {
    identityId: identity.id,
    timestamp: new Date().toISOString(),
    workspaceId: identity.workspaceId,
  };
}

function applyDenyPolicies(
  scopes: string[],
  policies: Policy[],
  context: EvaluationContext,
): string[] {
  const denyPolicies = policies.filter((policy) => policy.effect === "deny");
  if (denyPolicies.length === 0) {
    return dedupeScopes(scopes);
  }

  return dedupeScopes(applyPolicies(scopes, denyPolicies, context));
}

function emptyInheritanceChain(): InheritanceChain {
  return {
    org: { scopes: [], roles: [], policies: [] },
    workspace: { scopes: [], roles: [], policies: [] },
    agent: { scopes: [], roles: [] },
    effective: [],
  };
}

function dedupeScopes(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === "string")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

function parseStringArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseRecordColumn(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function safeParseScope(scope: string) {
  try {
    return parseScope(scope);
  } catch {
    return null;
  }
}

function scopeMatches(requested: string, granted: string): boolean {
  const parsedRequested = safeParseScope(requested);
  const parsedGranted = safeParseScope(granted);
  if (!parsedRequested || !parsedGranted) {
    return false;
  }

  if (parsedGranted.plane !== "*" && parsedGranted.plane !== parsedRequested.plane) {
    return false;
  }

  if (parsedGranted.resource !== "*" && parsedGranted.resource !== parsedRequested.resource) {
    return false;
  }

  if (!actionMatches(parsedRequested.action, parsedGranted.action)) {
    return false;
  }

  return pathMatches(
    parsedRequested.path,
    parsedGranted.path,
    parsedRequested.plane,
    parsedRequested.resource,
  );
}

function actionMatches(requested: string, granted: string): boolean {
  if (granted === "*" || granted === requested) {
    return true;
  }

  return granted === "manage" && ["read", "write", "create", "delete"].includes(requested);
}

function pathMatches(
  requestedPath: string,
  grantedPath: string,
  plane: string,
  resource: string,
): boolean {
  if (grantedPath === "*" || grantedPath === requestedPath) {
    return true;
  }

  if (plane === "relayfile" && resource === "fs" && grantedPath.endsWith("/*")) {
    const prefix = grantedPath.slice(0, -1);
    return requestedPath.startsWith(prefix);
  }

  if (!grantedPath.includes("*")) {
    return false;
  }

  const pattern = `^${escapeRegExp(grantedPath).replace(/\\\*/g, ".*")}$`;
  return new RegExp(pattern).test(requestedPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
