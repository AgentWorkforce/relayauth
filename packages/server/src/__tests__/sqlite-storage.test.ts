import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuditEntry, Policy, Role } from "@relayauth/types";

import type { AuthStorage, StoredIdentity } from "../storage/interface.js";
import { createSqliteStorage } from "../storage/sqlite.js";

function createHarness(): { storage: AuthStorage; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relayauth-sqlite-"));
  const storage = createSqliteStorage(join(dir, "relayauth.db"));

  return {
    storage,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures from open handles in native sqlite builds.
      }
    },
  };
}

function createIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const id = overrides.id ?? `agent_${Math.random().toString(36).slice(2)}`;
  const createdAt = overrides.createdAt ?? "2026-03-27T10:00:00.000Z";
  const updatedAt = overrides.updatedAt ?? createdAt;

  return {
    id,
    name: overrides.name ?? `Identity ${id}`,
    type: overrides.type ?? "agent",
    orgId: overrides.orgId ?? "org_test",
    workspaceId: overrides.workspaceId ?? "ws_test",
    sponsorId: overrides.sponsorId ?? "sponsor_root",
    sponsorChain: overrides.sponsorChain ?? ["sponsor_root", id],
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? ["relayauth:identity:read"],
    roles: overrides.roles ?? ["operator"],
    metadata: overrides.metadata ?? { team: "infra" },
    createdAt,
    updatedAt,
    ...(overrides.lastActiveAt ? { lastActiveAt: overrides.lastActiveAt } : {}),
    ...(overrides.suspendedAt ? { suspendedAt: overrides.suspendedAt } : {}),
    ...(overrides.suspendReason ? { suspendReason: overrides.suspendReason } : {}),
    ...(overrides.budget ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createRole(overrides: Partial<Role> = {}): Role {
  const id = overrides.id ?? `role_${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: overrides.name ?? id,
    description: overrides.description ?? "Role description",
    scopes: overrides.scopes ?? ["relayauth:identity:read"],
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
    builtIn: overrides.builtIn ?? false,
    createdAt: overrides.createdAt ?? "2026-03-27T12:00:00.000Z",
  };
}

function createPolicy(overrides: Partial<Policy> = {}): Policy {
  const id = overrides.id ?? `pol_${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: overrides.name ?? id,
    effect: overrides.effect ?? "allow",
    scopes: overrides.scopes ?? ["relayauth:identity:read"],
    conditions: overrides.conditions ?? [],
    priority: overrides.priority ?? 0,
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
    createdAt: overrides.createdAt ?? "2026-03-27T12:30:00.000Z",
  };
}

function createAuditEntry(overrides: Partial<AuditEntry> = {}): Omit<AuditEntry, "id"> & { id: string } {
  return {
    id: overrides.id ?? `aud_${Math.random().toString(36).slice(2)}`,
    action: overrides.action ?? "scope.checked",
    identityId: overrides.identityId ?? "agent_parent",
    orgId: overrides.orgId ?? "org_test",
    result: overrides.result ?? "allowed",
    timestamp: overrides.timestamp ?? "2026-03-27T13:00:00.000Z",
    ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
    ...(overrides.plane ? { plane: overrides.plane } : {}),
    ...(overrides.resource ? { resource: overrides.resource } : {}),
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
    ...(overrides.ip ? { ip: overrides.ip } : {}),
    ...(overrides.userAgent ? { userAgent: overrides.userAgent } : {}),
  };
}

test("sqlite identity storage supports CRUD, hierarchy, and budget auto-suspend", async () => {
  const { storage, cleanup } = createHarness();

  try {
    const parent = createIdentity({
      id: "agent_parent",
      name: "Parent Agent",
      createdAt: "2026-03-27T10:00:00.000Z",
      updatedAt: "2026-03-27T10:00:00.000Z",
    });
    const child = createIdentity({
      id: "agent_child",
      name: "Child Agent",
      sponsorId: parent.id,
      sponsorChain: ["sponsor_root", parent.id, "agent_child"],
      createdAt: "2026-03-27T11:00:00.000Z",
      updatedAt: "2026-03-27T11:00:00.000Z",
    });
    const budgeted = createIdentity({
      id: "agent_budgeted",
      name: "Budgeted Agent",
      createdAt: "2026-03-27T12:00:00.000Z",
      updatedAt: "2026-03-27T12:00:00.000Z",
      budget: {
        maxActionsPerHour: 5,
        autoSuspend: true,
      },
      budgetUsage: {
        actionsThisHour: 6,
        costToday: 0,
        lastResetAt: "2026-03-27T00:00:00.000Z",
      },
    });

    const createdParent = await storage.identities.create(parent);
    const createdChild = await storage.identities.create(child);
    const createdBudgeted = await storage.identities.create(budgeted);

    assert.equal(createdBudgeted.status, "suspended");
    assert.equal(createdBudgeted.suspendReason, "budget_exceeded");

    const loadedParent = await storage.identities.get(parent.id);
    assert.ok(loadedParent);
    assert.equal(loadedParent.name, "Parent Agent");

    const updatedParent = await storage.identities.update(parent.id, {
      metadata: { owner: "ops" },
      roles: ["operator", "reviewer"],
    });
    assert.deepEqual(updatedParent.metadata, { team: "infra", owner: "ops" });
    assert.deepEqual(updatedParent.roles, ["operator", "reviewer"]);

    const listed = await storage.identities.list("org_test", { limit: 2 });
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, createdBudgeted.id);
    assert.equal(listed[1]?.id, createdChild.id);

    const afterCursor = await storage.identities.list("org_test", {
      limit: 5,
      cursorId: createdChild.id,
    });
    assert.equal(afterCursor.length, 1);
    assert.equal(afterCursor[0]?.id, createdParent.id);

    const duplicate = await storage.identities.findDuplicate("org_test", "Parent Agent");
    assert.deepEqual(duplicate, {
      id: createdParent.id,
      name: "Parent Agent",
      orgId: "org_test",
    });

    const childIds = await storage.identities.listChildIds("org_test", parent.id);
    assert.deepEqual(childIds, [createdChild.id]);

    const children = await storage.identities.listChildren("org_test", parent.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]?.id, createdChild.id);
    assert.equal(children[0]?.status, "active");

    const statusCounts = await storage.identities.getStatusCounts("org_test");
    assert.deepEqual(statusCounts, {
      activeIdentities: 2,
      suspendedIdentities: 1,
    });

    const suspended = await storage.identities.suspend(parent.id, "manual_review");
    assert.equal(suspended.status, "suspended");
    assert.equal(suspended.suspendReason, "manual_review");

    const reactivated = await storage.identities.reactivate(parent.id);
    assert.equal(reactivated.status, "active");
    assert.equal(reactivated.suspendedAt, undefined);
    assert.equal(reactivated.suspendReason, undefined);

    const retired = await storage.identities.retire(parent.id, "decommissioned");
    assert.equal(retired.status, "retired");
    await assert.rejects(
      () => storage.identities.reactivate(parent.id),
      /Retired identities cannot be reactivated/,
    );

    await storage.identities.delete(createdChild.id);
    const deletedChild = await storage.identities.get(createdChild.id);
    assert.equal(deletedChild, null);
  } finally {
    cleanup();
  }
});

test("sqlite storage supports roles, policies, audit, webhooks, contexts, and revocations", async () => {
  const { storage, cleanup } = createHarness();

  try {
    const globalRole = await storage.roles.create(
      createRole({
        id: "role_global",
        name: "auditor",
      }),
    );
    const workspaceRole = await storage.roles.create(
      createRole({
        id: "role_workspace",
        name: "workspace-operator",
        workspaceId: "ws_ops",
      }),
    );

    const roles = await storage.roles.list("org_test", "ws_ops");
    assert.deepEqual(
      roles.map((role) => role.id),
      ["role_global", "role_workspace"],
    );

    const listedByIds = await storage.roles.listByIds([workspaceRole.id, globalRole.id]);
    assert.equal(listedByIds.length, 2);

    const updatedRole = await storage.roles.update(globalRole.id, {
      scopes: ["relayauth:identity:read", "relayauth:audit:read"],
    });
    assert.deepEqual(updatedRole.scopes, ["relayauth:identity:read", "relayauth:audit:read"]);

    const lowPriorityPolicy = await storage.policies.create(
      createPolicy({
        id: "policy_low",
        priority: 10,
      }),
    );
    const highPriorityPolicy = await storage.policies.create(
      createPolicy({
        id: "policy_high",
        priority: 50,
        workspaceId: "ws_ops",
      }),
    );

    const policies = await storage.policies.list("org_test", "ws_ops");
    assert.deepEqual(
      policies.map((policy) => policy.id),
      ["policy_high", "policy_low"],
    );

    const updatedPolicy = await storage.policies.update(lowPriorityPolicy.id, {
      priority: 20,
      conditions: [{ type: "workspace", operator: "eq", value: "ws_ops" }],
    });
    assert.equal(updatedPolicy.priority, 20);
    assert.equal(updatedPolicy.conditions.length, 1);

    await storage.policies.delete(highPriorityPolicy.id);
    const deletedPolicy = await storage.policies.get(highPriorityPolicy.id);
    assert.equal(deletedPolicy, null);

    await storage.audit.write(createAuditEntry({
      id: "aud_newer",
      action: "scope.checked",
      identityId: "agent_parent",
      orgId: "org_test",
      result: "allowed",
      timestamp: "2026-03-27T15:00:00.000Z",
      metadata: { sponsorId: "sponsor_root", sponsorChain: "[\"sponsor_root\"]" },
    }));
    await storage.audit.write(createAuditEntry({
      id: "aud_older",
      action: "token.revoked",
      identityId: "agent_parent",
      orgId: "org_test",
      result: "allowed",
      timestamp: "2026-03-27T14:00:00.000Z",
      metadata: { sponsorId: "sponsor_root", sponsorChain: "[\"sponsor_root\"]" },
    }));

    const queriedAudit = await storage.audit.query({
      orgId: "org_test",
      limit: 1,
    });
    assert.equal(queriedAudit.length, 2);
    assert.equal(queriedAudit[0]?.id, "aud_newer");

    const actionCounts = await storage.audit.getActionCounts("org_test", {});
    assert.deepEqual(actionCounts, {
      tokensIssued: 0,
      tokensRevoked: 1,
      tokensRefreshed: 0,
      scopeChecks: 1,
      scopeDenials: 0,
    });

    const suspendedIdentity = createIdentity({
      id: "agent_for_audit_event",
      sponsorChain: ["sponsor_root", "agent_for_audit_event"],
    });
    await storage.identities.create(suspendedIdentity);
    await storage.audit.writeIdentitySuspendedEvent(suspendedIdentity, "manual_review", "actor_1");

    const createdWebhook = await storage.auditWebhooks.create({
      orgId: "org_test",
      url: "https://example.com/audit",
      secret: "super-secret",
      events: ["scope.checked", "token.revoked"],
    });
    const listedWebhooks = await storage.auditWebhooks.list("org_test");
    assert.equal(listedWebhooks.length, 1);
    assert.equal(listedWebhooks[0]?.id, createdWebhook.id);

    await storage.auditWebhooks.delete("org_test", createdWebhook.id);
    const afterDelete = await storage.auditWebhooks.list("org_test");
    assert.equal(afterDelete.length, 0);

    const contexts = await Promise.all([
      storage.contexts.getOrganization("org_test"),
      storage.contexts.getWorkspace("ws_test"),
    ]);
    assert.deepEqual(contexts, [null, null]);

    const revocations = storage.revocations as AuthStorage["revocations"] & {
      isRevoked?: (tokenId: string) => Promise<boolean>;
    };
    await revocations.revokeIdentityTokens("agent_parent", ["tok_1"], "2026-03-27T16:00:00.000Z");
    if (typeof revocations.isRevoked === "function") {
      assert.equal(await revocations.isRevoked("tok_1"), true);
    }

    await storage.roles.delete(workspaceRole.id);
    const deletedRole = await storage.roles.get(workspaceRole.id);
    assert.equal(deletedRole, null);
  } finally {
    cleanup();
  }
});
