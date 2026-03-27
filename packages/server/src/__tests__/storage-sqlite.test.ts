import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Policy, Role } from "@relayauth/types";
import { createSqliteStorage } from "../storage/sqlite.js";

function createTempStorage(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "relayauth-sqlite-"));
  const dbPath = join(directory, "relayauth.sqlite");
  const storage = createSqliteStorage(dbPath);

  t.after(async () => {
    await storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory, dbPath, storage };
}

test("TestSqliteIdentityCRUD", async (t) => {
  const { storage } = createTempStorage(t);

  const created = await storage.identities.create({
    id: "agent_sqlite_crud",
    name: "SQLite CRUD Agent",
    type: "agent",
    orgId: "org_sqlite",
    status: "active",
    createdAt: "2026-03-27T09:00:00.000Z",
    updatedAt: "2026-03-27T09:00:00.000Z",
    workspaceId: "ws_sqlite",
    sponsorId: "user_sqlite",
    sponsorChain: ["user_sqlite", "agent_sqlite_crud"],
    scopes: ["relayauth:identity:read:*"],
    roles: ["observer"],
    metadata: { team: "platform" },
  });

  assert.equal(created.id, "agent_sqlite_crud");
  assert.equal(created.status, "active");

  const fetched = await storage.identities.get(created.id);
  assert.deepEqual(fetched, created);

  const updated = await storage.identities.update(created.id, {
    name: "SQLite CRUD Agent Updated",
    roles: ["observer", "admin"],
    metadata: { owner: "alice" },
  });

  assert.equal(updated.name, "SQLite CRUD Agent Updated");
  assert.deepEqual(updated.roles, ["observer", "admin"]);
  assert.deepEqual(updated.metadata, { team: "platform", owner: "alice" });

  const listed = await storage.identities.list("org_sqlite");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  await storage.identities.delete(created.id);

  assert.equal(await storage.identities.get(created.id), null);
  const afterDelete = await storage.identities.list("org_sqlite");
  assert.deepEqual(afterDelete, []);
});

test("TestSqliteIdentitySuspendRetire", async (t) => {
  const { storage } = createTempStorage(t);

  const created = await storage.identities.create({
    id: "agent_sqlite_lifecycle",
    name: "SQLite Lifecycle Agent",
    type: "service",
    orgId: "org_lifecycle",
    status: "active",
    createdAt: "2026-03-27T10:00:00.000Z",
    updatedAt: "2026-03-27T10:00:00.000Z",
    workspaceId: "ws_lifecycle",
    sponsorId: "user_lifecycle",
    sponsorChain: ["user_lifecycle", "agent_sqlite_lifecycle"],
    scopes: ["relayauth:identity:manage:*"],
    roles: ["operator"],
    metadata: {},
  });

  const suspended = await storage.identities.suspend(created.id, "manual_review");
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspendReason, "manual_review");
  assert.equal(typeof suspended.suspendedAt, "string");

  const reactivated = await storage.identities.reactivate(created.id);
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.suspendedAt, undefined);
  assert.equal(reactivated.suspendReason, undefined);

  const retired = await storage.identities.retire(created.id);
  assert.equal(retired.status, "retired");
  assert.equal(retired.suspendedAt, undefined);
  assert.equal(retired.suspendReason, undefined);
});

test("TestSqliteRevocation", async (t) => {
  const { storage } = createTempStorage(t);

  assert.equal(await storage.revocations.isRevoked("jti_missing"), false);

  await storage.revocations.revoke("jti_revoked", Math.floor(Date.now() / 1000) + 3600);

  assert.equal(await storage.revocations.isRevoked("jti_revoked"), true);
  assert.equal(await storage.revocations.isRevoked("jti_other"), false);
});

test("TestSqliteRoleCRUD", async (t) => {
  const { storage } = createTempStorage(t);

  const created: Role = await storage.roles.create({
    id: "role_sqlite_admin",
    name: "sqlite-admin",
    description: "SQLite admin role",
    scopes: ["relayauth:role:manage:*"],
    orgId: "org_roles",
    workspaceId: "ws_roles",
    builtIn: false,
    createdAt: "2026-03-27T10:00:00.000Z",
  });

  const fetched = await storage.roles.get(created.id);
  assert.deepEqual(fetched, created);

  const listed = await storage.roles.list("org_roles", "ws_roles");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  const updated = await storage.roles.update(created.id, {
    description: "Updated SQLite admin role",
    scopes: ["relayauth:role:manage:*", "relayauth:role:read:*"],
  });
  assert.equal(updated.description, "Updated SQLite admin role");
  assert.deepEqual(updated.scopes, ["relayauth:role:manage:*", "relayauth:role:read:*"]);

  await storage.roles.delete(created.id);

  assert.equal(await storage.roles.get(created.id), null);
  assert.deepEqual(await storage.roles.list("org_roles", "ws_roles"), []);
});

test("TestSqlitePolicyCRUD", async (t) => {
  const { storage } = createTempStorage(t);

  const created: Policy = await storage.policies.create({
    id: "policy_sqlite_allow",
    name: "sqlite-allow",
    effect: "allow",
    scopes: ["relayfile:fs:read:*"],
    conditions: [{ type: "workspace", operator: "eq", value: "ws_policies" }],
    priority: 50,
    orgId: "org_policies",
    workspaceId: "ws_policies",
    createdAt: "2026-03-27T11:00:00.000Z",
  });

  const fetched = await storage.policies.get(created.id);
  assert.deepEqual(fetched, created);

  const listed = await storage.policies.list("org_policies", "ws_policies");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  const updated = await storage.policies.update(created.id, {
    effect: "deny",
    priority: 75,
    conditions: [{ type: "ip", operator: "eq", value: "203.0.113.10" }],
  });
  assert.equal(updated.effect, "deny");
  assert.equal(updated.priority, 75);
  assert.deepEqual(updated.conditions, [{ type: "ip", operator: "eq", value: "203.0.113.10" }]);

  await storage.policies.delete(created.id);

  assert.equal(await storage.policies.get(created.id), null);
  assert.deepEqual(await storage.policies.list("org_policies", "ws_policies"), []);
});

test("TestSqliteAuditLog", async (t) => {
  const { storage } = createTempStorage(t);

  const entries: Array<Parameters<typeof storage.audit.write>[0]> = [
    {
      action: "identity.created",
      identityId: "agent_audit_1",
      orgId: "org_audit",
      workspaceId: "ws_audit",
      plane: "relayauth",
      resource: "/v1/identities",
      result: "allowed",
      metadata: { sponsorId: "user_audit", sponsorChain: "[\"user_audit\",\"agent_audit_1\"]" },
      ip: "203.0.113.10",
      userAgent: "node:test",
      timestamp: "2026-03-27T12:00:00.000Z",
    },
    {
      action: "identity.updated",
      identityId: "agent_audit_1",
      orgId: "org_audit",
      workspaceId: "ws_audit",
      plane: "relayauth",
      resource: "/v1/identities/agent_audit_1",
      result: "allowed",
      metadata: { sponsorId: "user_audit", sponsorChain: "[\"user_audit\",\"agent_audit_1\"]" },
      ip: "203.0.113.10",
      userAgent: "node:test",
      timestamp: "2026-03-27T12:30:00.000Z",
    },
  ];

  for (const entry of entries) {
    await storage.audit.write(entry);
  }

  const byOrg = await storage.audit.query({ orgId: "org_audit", limit: 10 });
  assert.equal(byOrg.length, 2);
  assert.equal(byOrg[0]?.action, "identity.updated");
  assert.equal(byOrg[1]?.action, "identity.created");

  const byTimeRange = await storage.audit.query({
    orgId: "org_audit",
    from: "2026-03-27T12:15:00.000Z",
    to: "2026-03-27T12:45:00.000Z",
    limit: 10,
  });
  assert.equal(byTimeRange.length, 1);
  assert.equal(byTimeRange[0]?.action, "identity.updated");
});

test("TestSqliteAutoCreateTables", async (t) => {
  const { dbPath, storage } = createTempStorage(t);

  const result = await storage.DB.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `).all<{ name?: string }>();
  const tables = result.results ?? [];

  assert.equal(existsSync(dbPath), true);

  const tableNames = new Set(
    tables
      .filter((row): row is { name: string } => typeof row.name === "string" && row.name.length > 0)
      .map((row) => row.name),
  );

  for (const tableName of [
    "identities",
    "roles",
    "policies",
    "audit_logs",
    "audit_events",
    "tokens",
    "org_budgets",
    "organizations",
    "workspaces",
    "audit_retention_config",
    "audit_webhooks",
    "revoked_tokens",
  ]) {
    assert.equal(tableNames.has(tableName), true, `expected ${tableName} to be auto-created`);
  }
});
