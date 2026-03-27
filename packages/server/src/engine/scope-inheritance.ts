import type { Policy, Role } from "@relayauth/types";
import type { StoredIdentity as BaseStoredIdentity } from "../durable-objects/identity-do.js";

type StoredIdentity = Omit<BaseStoredIdentity, "workspaceId"> & { workspaceId?: string };
import { applyPolicies, evaluateCondition, scopeMatches as policyEvalScopeMatches } from "./policy-evaluation.js";
import { listPolicies } from "./policies.js";
import { listIdentityRoles } from "./role-assignments.js";
import type { AuthStorage } from "../storage/index.js";
import { resolveAuthStorage } from "../storage/index.js";

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

type ScopeInheritanceStorageSource = D1Database | AuthStorage;

export async function resolveInheritedScopes(
  storageSource: ScopeInheritanceStorageSource,
  identityId: string,
): Promise<string[]> {
  const chain = await getInheritanceChain(storageSource, identityId);
  return chain.effective;
}

export async function getInheritanceChain(
  storageSource: ScopeInheritanceStorageSource,
  identityId: string,
): Promise<InheritanceChain> {
  const storage = resolveAuthStorage(storageSource);
  const identity = await getIdentity(storage, identityId);
  if (!identity || identity.status !== "active") {
    return emptyInheritanceChain();
  }

  const [orgContext, workspaceContext, agentContext, loadedPolicies] = await Promise.all([
    loadOrganizationContext(storage, identity.orgId),
    identity.workspaceId
      ? loadWorkspaceContext(storage, identity.workspaceId)
      : Promise.resolve({ scopes: [], roles: [] } as WorkspaceContext),
    loadAgentContext(storage, identity),
    listPolicies(storage, identity.orgId, identity.workspaceId),
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

async function getOrgScopes(storageSource: AuthStorage | D1Database, orgId: string): Promise<string[]> {
  const context = await loadOrganizationContext(resolveAuthStorage(storageSource), orgId);
  return context.scopes;
}

async function getWorkspaceScopes(storageSource: AuthStorage | D1Database, workspaceId: string): Promise<string[]> {
  const context = await loadWorkspaceContext(resolveAuthStorage(storageSource), workspaceId);
  return context.scopes;
}

async function getAgentScopes(storageSource: AuthStorage | D1Database, identityId: string): Promise<string[]> {
  const storage = resolveAuthStorage(storageSource);
  const identity = await getIdentity(storage, identityId);
  if (!identity) {
    return [];
  }
  const context = await loadAgentContext(storage, identity);
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
  storage: AuthStorage,
  orgId: string,
): Promise<OrganizationContext> {
  const organization = await storage.contexts.getOrganization(orgId.trim());
  if (!organization) {
    return { scopes: [], roles: [] };
  }

  const roles = await loadRolesByIds(storage, organization.roles);
  const scopes = dedupeScopes([
    ...organization.scopes,
    ...roles.flatMap((role) => role.scopes),
  ]);

  return { scopes, roles };
}

async function loadWorkspaceContext(
  storage: AuthStorage,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const workspace = await storage.contexts.getWorkspace(workspaceId.trim());
  if (!workspace) {
    return { scopes: [], roles: [] };
  }

  const roles = await loadRolesByIds(storage, workspace.roles);
  const scopes = dedupeScopes([
    ...workspace.scopes,
    ...roles.flatMap((role) => role.scopes),
  ]);

  return { scopes, roles };
}

async function loadAgentContext(
  storage: AuthStorage,
  identity: StoredIdentity,
): Promise<AgentContext> {
  const roles = await listIdentityRoles(storage, identity.id);

  const scopes = dedupeScopes([
    ...identity.scopes,
    ...roles.flatMap((role) => role.scopes),
  ]);

  return { scopes, roles };
}

async function loadRolesByIds(storage: AuthStorage, roleIds: string[]): Promise<Role[]> {
  return storage.roles.listByIds(dedupeScopes(roleIds));
}

async function getIdentity(
  storage: AuthStorage,
  identityId: string,
): Promise<StoredIdentity | null> {
  const identity = await storage.identities.get(identityId.trim());
  return identity ? { ...identity } : null;
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

// Use the canonical implementation from policy-evaluation to avoid divergent copies
const scopeMatches = policyEvalScopeMatches;
