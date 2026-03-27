import assert from "node:assert/strict";
import test from "node:test";
import type { Policy, Role } from "@relayauth/types";
import type { StoredIdentity } from "../durable-objects/identity-do.js";
import type { AuthStorage } from "../storage/index.js";
import {
  createTestStorage,
  generateTestIdentity,
  seedOrganizationContext,
  seedStoredIdentities,
  seedWorkspaceContext,
} from "./test-helpers.js";

type OrganizationRecord = {
  id: string;
  name: string;
  scopes: string[];
  roles: string[];
  createdAt: string;
  updatedAt: string;
};

type WorkspaceRecord = {
  id: string;
  name: string;
  orgId: string;
  scopes: string[];
  roles: string[];
  createdAt: string;
  updatedAt: string;
};

type StoredPolicy = Policy & {
  deletedAt?: string | null;
};

type InheritanceChain = {
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

type ScopeInheritanceModule = {
  resolveInheritedScopes?: (storage: AuthStorage, identityId: string) => Promise<string[]>;
  getInheritanceChain?: (storage: AuthStorage, identityId: string) => Promise<InheritanceChain>;
};

type ScopeInheritanceStorage = ReturnType<typeof createTestStorage>;

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity({
    ...overrides,
    id: overrides.id ?? "agent_scope_inheritance",
    orgId: overrides.orgId ?? "org_acme",
    roles: overrides.roles ?? [],
    scopes: overrides.scopes ?? [],
    status: overrides.status ?? "active",
  });
  const sponsorId = overrides.sponsorId ?? "user_owner_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, base.id],
    workspaceId: overrides.workspaceId ?? "ws_default",
  };
}

function createRole(overrides: Partial<Role> = {}): Role {
  return {
    id: overrides.id ?? "role_scope_reader",
    name: overrides.name ?? "scope-reader",
    description: overrides.description ?? "Scope inheritance role",
    scopes: overrides.scopes ?? ["relayfile:fs:read:/org/*"],
    orgId: overrides.orgId ?? "org_acme",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    builtIn: overrides.builtIn ?? false,
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function createPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: overrides.id ?? "pol_scope_rule",
    name: overrides.name ?? "scope-rule",
    effect: overrides.effect ?? "allow",
    scopes: overrides.scopes ?? ["relayfile:fs:read:/org/*"],
    conditions: overrides.conditions ?? [],
    priority: overrides.priority ?? 500,
    orgId: overrides.orgId ?? "org_acme",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
  };
}

function createOrganization(overrides: Partial<OrganizationRecord> = {}): OrganizationRecord {
  return {
    id: overrides.id ?? "org_acme",
    name: overrides.name ?? "Acme",
    scopes: overrides.scopes ?? [],
    roles: overrides.roles ?? [],
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function createWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: overrides.id ?? "ws_default",
    name: overrides.name ?? "Default Workspace",
    orgId: overrides.orgId ?? "org_acme",
    scopes: overrides.scopes ?? [],
    roles: overrides.roles ?? [],
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-25T10:00:00.000Z",
  };
}

async function createScopeInheritanceStorage(input: {
  organizations?: OrganizationRecord[];
  workspaces?: WorkspaceRecord[];
  identities: StoredIdentity[];
  roles?: Role[];
  policies?: StoredPolicy[];
}): Promise<ScopeInheritanceStorage> {
  const storage = createTestStorage();

  if (input.organizations) {
    for (const organization of input.organizations) {
      await seedOrganizationContext(storage, {
        id: organization.id,
        orgId: organization.id,
        scopes: organization.scopes,
        roles: organization.roles,
      });
    }
  }

  if (input.workspaces) {
    for (const workspace of input.workspaces) {
      await seedWorkspaceContext(storage, {
        id: workspace.id,
        workspaceId: workspace.id,
        orgId: workspace.orgId,
        scopes: workspace.scopes,
        roles: workspace.roles,
      });
    }
  }

  await seedStoredIdentities(storage, input.identities);

  if (input.roles) {
    for (const role of input.roles) {
      await storage.roles.create(role);
    }
  }

  if (input.policies) {
    for (const policy of input.policies) {
      const { deletedAt: _deletedAt, ...activePolicy } = policy;
      await storage.policies.create(activePolicy);
      if (policy.deletedAt) {
        await storage.policies.delete(policy.id);
      }
    }
  }

  return storage;
}

async function loadScopeInheritanceModule(): Promise<Required<ScopeInheritanceModule>> {
  let module: ScopeInheritanceModule;

  try {
    module = await import("../engine/scope-inheritance.js") as ScopeInheritanceModule;
  } catch (error) {
    assert.fail(
      [
        "Expected ../engine/scope-inheritance.js to exist.",
        "Implement and export resolveInheritedScopes(storage, identityId) and getInheritanceChain(storage, identityId).",
        error instanceof Error ? error.message : String(error),
      ].join(" "),
    );
  }

  assert.equal(
    typeof module.resolveInheritedScopes,
    "function",
    "Expected scope inheritance engine to export resolveInheritedScopes(storage, identityId)",
  );
  assert.equal(
    typeof module.getInheritanceChain,
    "function",
    "Expected scope inheritance engine to export getInheritanceChain(storage, identityId)",
  );

  return module as Required<ScopeInheritanceModule>;
}

function sortScopes(scopes: string[]): string[] {
  return [...scopes].sort((left, right) => left.localeCompare(right));
}

function sortIds(values: Array<{ id: string }>): string[] {
  return values.map((value) => value.id).sort((left, right) => left.localeCompare(right));
}

function assertIncludes(scopes: string[], expected: string, message: string) {
  assert.equal(scopes.includes(expected), true, message);
}

function assertExcludes(scopes: string[], unexpected: string, message: string) {
  assert.equal(scopes.includes(unexpected), false, message);
}

test("org-level scopes are inherited by identities in every workspace in the org", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_reports_reader",
    name: "org-reports-reader",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const wsAlpha = createWorkspace({ id: "ws_alpha", orgId: org.id });
  const wsBeta = createWorkspace({ id: "ws_beta", orgId: org.id });
  const alphaIdentity = createStoredIdentity({
    id: "agent_alpha",
    orgId: org.id,
    workspaceId: wsAlpha.id,
    scopes: [],
    roles: [],
  });
  const betaIdentity = createStoredIdentity({
    id: "agent_beta",
    orgId: org.id,
    workspaceId: wsBeta.id,
    scopes: [],
    roles: [],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [wsAlpha, wsBeta],
    identities: [alphaIdentity, betaIdentity],
    roles: [orgRole],
  });
  t.after(() => storage.close());

  const [alphaScopes, betaScopes] = await Promise.all([
    resolveInheritedScopes(storage, alphaIdentity.id),
    resolveInheritedScopes(storage, betaIdentity.id),
  ]);

  assertIncludes(alphaScopes, "relayfile:fs:read:/org/*", "org scopes should flow into ws_alpha");
  assertIncludes(betaScopes, "relayfile:fs:read:/org/*", "org scopes should flow into ws_beta");
});

test("workspace-level scopes are inherited by all agents in that workspace", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_docs_reader",
    name: "org-docs-reader",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_docs_reader",
    name: "workspace-docs-reader",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const agentOne = createStoredIdentity({
    id: "agent_team_a_1",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const agentTwo = createStoredIdentity({
    id: "agent_team_a_2",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [agentOne, agentTwo],
    roles: [orgRole, workspaceRole],
  });
  t.after(() => storage.close());

  const [agentOneScopes, agentTwoScopes] = await Promise.all([
    resolveInheritedScopes(storage, agentOne.id),
    resolveInheritedScopes(storage, agentTwo.id),
  ]);

  assertIncludes(
    agentOneScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scopes should be inherited by the first agent in ws_team_a",
  );
  assertIncludes(
    agentTwoScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scopes should be inherited by the second agent in ws_team_a",
  );
});

test("agent direct scopes are combined with inherited scopes", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_reader_direct",
    name: "org-reader-direct",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_reader_direct",
    name: "workspace-reader-direct",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_direct_scope",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: ["relayfile:fs:read:/org/team-a/reports/q1.csv"],
    roles: [],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole],
  });
  t.after(() => storage.close());

  const effectiveScopes = await resolveInheritedScopes(storage, identity.id);

  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scope should remain present in the effective scope set",
  );
  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/reports/q1.csv",
    "direct scope should be merged into the inherited scope set",
  );
});

test("workspace scopes cannot exceed org-level scopes and must be intersected", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_boundary",
    name: "org-boundary",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceReadRole = createRole({
    id: "role_ws_allowed_read",
    name: "workspace-allowed-read",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const workspaceWriteRole = createRole({
    id: "role_ws_disallowed_write",
    name: "workspace-disallowed-write",
    scopes: ["relayfile:fs:write:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const workspaceOutsideRole = createRole({
    id: "role_ws_outside_boundary",
    name: "workspace-outside-boundary",
    scopes: ["relayfile:fs:read:/finance/*"],
    workspaceId: "ws_team_a",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: [
      ...workspaceReadRole.scopes,
      ...workspaceWriteRole.scopes,
      ...workspaceOutsideRole.scopes,
    ],
    roles: [workspaceReadRole.id, workspaceWriteRole.id, workspaceOutsideRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_workspace_intersection",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceReadRole, workspaceWriteRole, workspaceOutsideRole],
  });
  t.after(() => storage.close());

  const effectiveScopes = await resolveInheritedScopes(storage, identity.id);

  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scope that is inside the org boundary should survive intersection",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:write:/org/team-a/*",
    "workspace scopes outside the org action boundary must be filtered out",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:read:/finance/*",
    "workspace scopes outside the org path boundary must be filtered out",
  );
});

test("agent scopes cannot exceed the workspace-level boundary", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_agent_boundary",
    name: "org-agent-boundary",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_agent_boundary",
    name: "workspace-agent-boundary",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const allowedAgentRole = createRole({
    id: "role_agent_allowed",
    name: "agent-allowed",
    scopes: ["relayfile:fs:read:/org/team-a/runbooks/*"],
  });
  const disallowedAgentRole = createRole({
    id: "role_agent_disallowed",
    name: "agent-disallowed",
    scopes: ["relayfile:fs:write:/org/team-a/runbooks/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_workspace_boundary",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [allowedAgentRole.id, disallowedAgentRole.id],
    scopes: [
      "relayfile:fs:read:/org/team-a/runbooks/deploy.md",
      "relayfile:fs:read:/org/team-b/secrets.txt",
    ],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, allowedAgentRole, disallowedAgentRole],
  });
  t.after(() => storage.close());

  const effectiveScopes = await resolveInheritedScopes(storage, identity.id);

  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/runbooks/*",
    "agent role scopes within the workspace boundary should be preserved",
  );
  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/runbooks/deploy.md",
    "direct scopes within the workspace boundary should be preserved",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:write:/org/team-a/runbooks/*",
    "agent role scopes outside the workspace action boundary must be removed",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-b/secrets.txt",
    "direct scopes outside the workspace path boundary must be removed",
  );
});

test("org deny policies block scopes even when the workspace level allows them", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_deploy",
    name: "org-deploy",
    scopes: ["cloud:workflow:run:prod-eu-*"],
  });
  const orgDeny = createPolicy({
    id: "pol_org_deny_deploy",
    name: "org-deny-deploy",
    effect: "deny",
    scopes: ["cloud:workflow:run:prod-eu-*"],
    priority: 900,
  });
  const workspaceAllow = createPolicy({
    id: "pol_ws_allow_deploy",
    name: "workspace-allow-deploy",
    effect: "allow",
    scopes: ["cloud:workflow:run:prod-eu-*"],
    priority: 100,
    workspaceId: "ws_prod",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_prod",
    orgId: org.id,
    scopes: orgRole.scopes,
    roles: [],
  });
  const identity = createStoredIdentity({
    id: "agent_prod_operator",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole],
    policies: [orgDeny, workspaceAllow],
  });
  t.after(() => storage.close());

  const effectiveScopes = await resolveInheritedScopes(storage, identity.id);

  assertExcludes(
    effectiveScopes,
    "cloud:workflow:run:prod-eu-*",
    "an org-level deny must outrank a workspace-level allow for the same scope",
  );
});

test("workspace deny policies block scopes even when the agent has them directly", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_finance_reader",
    name: "org-finance-reader",
    scopes: ["relayfile:fs:read:/finance/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_finance_reader",
    name: "workspace-finance-reader",
    scopes: ["relayfile:fs:read:/finance/*"],
    workspaceId: "ws_finance",
  });
  const workspaceDeny = createPolicy({
    id: "pol_ws_finance_deny",
    name: "workspace-finance-deny",
    effect: "deny",
    scopes: ["relayfile:fs:read:/finance/*"],
    priority: 800,
    workspaceId: "ws_finance",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_finance",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_finance",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: ["relayfile:fs:read:/finance/*"],
    roles: [],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole],
    policies: [workspaceDeny],
  });
  t.after(() => storage.close());

  const effectiveScopes = await resolveInheritedScopes(storage, identity.id);

  assertExcludes(
    effectiveScopes,
    "relayfile:fs:read:/finance/*",
    "workspace deny policies must remove directly assigned agent scopes",
  );
});

test("resolveInheritedScopes resolves the effective scopes from the full inheritance chain", async (t) => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_docs",
    name: "org-docs",
    scopes: ["relayfile:fs:read:/docs/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_docs",
    name: "workspace-docs",
    scopes: ["relayfile:fs:read:/docs/team-a/*"],
    workspaceId: "ws_docs",
  });
  const agentRole = createRole({
    id: "role_agent_docs",
    name: "agent-docs",
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_docs",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_docs",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [agentRole.id],
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/deploy.md"],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, agentRole],
  });
  t.after(() => storage.close());

  const effectiveScopes = await resolveInheritedScopes(storage, identity.id);

  assert.deepEqual(
    sortScopes(effectiveScopes),
    sortScopes([
      "relayfile:fs:read:/docs/*",
      "relayfile:fs:read:/docs/team-a/*",
      "relayfile:fs:read:/docs/team-a/runbooks/*",
      "relayfile:fs:read:/docs/team-a/runbooks/deploy.md",
    ]),
  );
});

test("inheritance chain is ordered org roles then workspace roles then agent roles then direct scopes", async (t) => {
  const { getInheritanceChain } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_chain",
    name: "org-chain",
    scopes: ["relayfile:fs:read:/docs/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_chain",
    name: "workspace-chain",
    scopes: ["relayfile:fs:read:/docs/team-a/*"],
    workspaceId: "ws_docs",
  });
  const agentRole = createRole({
    id: "role_agent_chain",
    name: "agent-chain",
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_docs",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_chain",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [agentRole.id],
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/deploy.md"],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, agentRole],
  });
  t.after(() => storage.close());

  const chain = await getInheritanceChain(storage, identity.id);

  assert.deepEqual(sortIds(chain.org.roles), [orgRole.id]);
  assert.deepEqual(sortIds(chain.workspace.roles), [workspaceRole.id]);
  assert.deepEqual(sortIds(chain.agent.roles), [agentRole.id]);
  assert.deepEqual(sortScopes(chain.org.scopes), sortScopes(orgRole.scopes));
  assert.deepEqual(sortScopes(chain.workspace.scopes), sortScopes(workspaceRole.scopes));
  assert.deepEqual(
    sortScopes(chain.agent.scopes),
    sortScopes([
      "relayfile:fs:read:/docs/team-a/runbooks/*",
      "relayfile:fs:read:/docs/team-a/runbooks/deploy.md",
    ]),
  );
});

test("getInheritanceChain returns the org, workspace, and agent scope breakdown", async (t) => {
  const { getInheritanceChain } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_breakdown",
    name: "org-breakdown",
    scopes: ["cloud:workflow:run:prod-*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_breakdown",
    name: "workspace-breakdown",
    scopes: ["cloud:workflow:run:prod-eu-*"],
    workspaceId: "ws_prod",
  });
  const agentRole = createRole({
    id: "role_agent_breakdown",
    name: "agent-breakdown",
    scopes: ["cloud:workflow:run:prod-eu-api"],
  });
  const orgPolicy = createPolicy({
    id: "pol_org_breakdown",
    name: "org-breakdown-policy",
    effect: "deny",
    scopes: ["cloud:workflow:delete:prod-*"],
    priority: 900,
  });
  const workspacePolicy = createPolicy({
    id: "pol_ws_breakdown",
    name: "workspace-breakdown-policy",
    effect: "allow",
    scopes: ["cloud:workflow:run:prod-eu-api"],
    priority: 400,
    workspaceId: "ws_prod",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_prod",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_breakdown",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [agentRole.id],
    scopes: ["cloud:workflow:run:prod-eu-api"],
  });
  const storage = await createScopeInheritanceStorage({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, agentRole],
    policies: [orgPolicy, workspacePolicy],
  });
  t.after(() => storage.close());

  const chain = await getInheritanceChain(storage, identity.id);

  assert.deepEqual(sortScopes(chain.org.scopes), sortScopes(orgRole.scopes));
  assert.deepEqual(sortScopes(chain.workspace.scopes), sortScopes(workspaceRole.scopes));
  assert.deepEqual(sortScopes(chain.agent.scopes), sortScopes(["cloud:workflow:run:prod-eu-api"]));
  assert.deepEqual(sortIds(chain.org.roles), [orgRole.id]);
  assert.deepEqual(sortIds(chain.workspace.roles), [workspaceRole.id]);
  assert.deepEqual(sortIds(chain.agent.roles), [agentRole.id]);
  assert.deepEqual(sortIds(chain.org.policies), [orgPolicy.id]);
  assert.deepEqual(sortIds(chain.workspace.policies), [workspacePolicy.id]);
  assert.deepEqual(
    sortScopes(chain.effective),
    sortScopes([
      "cloud:workflow:run:prod-*",
      "cloud:workflow:run:prod-eu-*",
      "cloud:workflow:run:prod-eu-api",
    ]),
  );
});
