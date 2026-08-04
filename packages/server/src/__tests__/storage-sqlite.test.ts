import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Policy, Role } from "@relayauth/types";
import {
  createAuditQueryContinuationFilterKey,
  createDashboardAuditContinuationFilterKey,
  StorageError,
  type AuditArchivePartitionCursor,
} from "../storage/interface.js";
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

function createForcedMemoryStorage(t: TestContext) {
  const storage = createSqliteStorage(undefined, { forceMemory: true });

  t.after(async () => {
    await storage.close();
  });

  return storage;
}

async function assertInclusiveArchiveCursorQuery(
  storage: ReturnType<typeof createSqliteStorage>,
) {
  for (const [id, timestamp] of [
    ["aud_after_partition", "2026-03-27T12:01:00.000Z"],
    ["aud_in_partition", "2026-03-27T12:00:59.000Z"],
    ["aud_partition_start", "2026-03-27T12:00:00.000Z"],
    ["aud_before_partition", "2026-03-27T11:59:59.000Z"],
  ]) {
    await storage.audit.write({
      id,
      action: "scope.checked",
      identityId: "agent_audit_cursor",
      orgId: "org_audit_cursor",
      result: "allowed",
      timestamp,
    });
  }

  const result = await storage.audit.query(
    {
      orgId: "org_audit_cursor",
      limit: 10,
      cursor: {
        kind: "archive_partition",
        orgId: "org_audit_cursor",
        timestamp: "2026-03-27T12:00:00.000Z",
        inclusive: true,
        filterKey: "storage-contract-test",
      },
    },
    { includeOverflowRow: false },
  );

  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["aud_in_partition", "aud_partition_start", "aud_before_partition"],
  );
}

async function assertOffsetArchiveCursorParity(
  storage: ReturnType<typeof createSqliteStorage>,
) {
  for (const [id, timestamp] of [
    ["aud_after_partition", "2026-03-27T12:01:00.000Z"],
    ["aud_in_partition", "2026-03-27T12:00:30.000Z"],
    ["aud_same_c", "2026-03-27T12:00:00.000Z"],
    ["aud_same_b", "2026-03-27T12:00:00.000Z"],
    ["aud_same_a", "2026-03-27T12:00:00.000Z"],
    ["aud_before_partition", "2026-03-27T11:59:59.000Z"],
  ]) {
    await storage.audit.write({
      id,
      action: "scope.checked",
      identityId: "agent_audit_offset_cursor",
      orgId: "org_audit_offset_cursor",
      result: "allowed",
      timestamp,
    });
  }

  const baseCursor = {
    kind: "archive_partition" as const,
    orgId: "org_audit_offset_cursor",
    filterKey: "storage-offset-contract-test",
  };
  const cases: Array<{
    name: string;
    utcCursor: AuditArchivePartitionCursor;
    offsetCursor: AuditArchivePartitionCursor;
    expectedIds: string[];
  }> = [
    {
      name: "non-inclusive",
      utcCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T12:00:00.000Z",
      },
      offsetCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T13:00:00.000+01:00",
      },
      expectedIds: ["aud_before_partition"],
    },
    {
      name: "chunked",
      utcCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T12:00:00.000Z",
        inclusive: true,
        chunk: { key: "chunk-2", sha256: "chunk-2-sha" },
      },
      offsetCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T13:00:00.000+01:00",
        inclusive: true,
        chunk: { key: "chunk-2", sha256: "chunk-2-sha" },
      },
      expectedIds: ["aud_before_partition"],
    },
    {
      name: "entry cursor",
      utcCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T13:00:00.000Z",
        entryCursor: {
          timestamp: "2026-03-27T12:00:00.000Z",
          id: "aud_same_b",
        },
      },
      offsetCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T14:00:00.000+01:00",
        entryCursor: {
          timestamp: "2026-03-27T13:00:00.000+01:00",
          id: "  aud_same_b  ",
        },
      },
      expectedIds: ["aud_same_a", "aud_before_partition"],
    },
    {
      name: "inclusive",
      utcCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T12:00:00.000Z",
        inclusive: true,
      },
      offsetCursor: {
        ...baseCursor,
        timestamp: "2026-03-27T13:00:00.000+01:00",
        inclusive: true,
      },
      expectedIds: [
        "aud_in_partition",
        "aud_same_c",
        "aud_same_b",
        "aud_same_a",
        "aud_before_partition",
      ],
    },
  ];

  for (const testCase of cases) {
    const utcResult = await storage.audit.query(
      {
        orgId: "org_audit_offset_cursor",
        limit: 10,
        cursor: testCase.utcCursor,
      },
      { includeOverflowRow: false },
    );
    const offsetResult = await storage.audit.query(
      {
        orgId: "org_audit_offset_cursor",
        limit: 10,
        cursor: testCase.offsetCursor,
      },
      { includeOverflowRow: false },
    );
    const utcIds = utcResult.entries.map((entry) => entry.id);
    const offsetIds = offsetResult.entries.map((entry) => entry.id);

    assert.deepEqual(offsetIds, utcIds, `${testCase.name} UTC parity`);
    assert.deepEqual(offsetIds, testCase.expectedIds, testCase.name);
    assert.equal(
      new Set(offsetIds).size,
      offsetIds.length,
      `${testCase.name} must not duplicate equivalent instants`,
    );
  }
}

async function assertOffsetEntryCursorPagination(
  storage: ReturnType<typeof createSqliteStorage>,
) {
  const expectedIds = [
    "aud_after",
    "aud_same_c",
    "aud_same_b",
    "aud_same_a",
    "aud_before",
  ];
  for (const [id, timestamp] of [
    ["aud_after", "2026-03-27T12:00:01.000Z"],
    ["aud_same_c", "2026-03-27T12:00:00.000Z"],
    ["aud_same_b", "2026-03-27T12:00:00.000Z"],
    ["aud_same_a", "2026-03-27T12:00:00.000Z"],
    ["aud_before", "2026-03-27T11:59:59.000Z"],
  ]) {
    await storage.audit.write({
      id,
      action: "scope.checked",
      identityId: "agent_entry_cursor_offset",
      orgId: "org_entry_cursor_offset",
      result: "allowed",
      timestamp,
    });
  }

  const queryPage = (timestamp?: string, id?: string) =>
    storage.audit.query(
      {
        orgId: "org_entry_cursor_offset",
        limit: 2,
        ...(timestamp && id ? { cursor: { timestamp, id } } : {}),
      },
      { includeOverflowRow: false },
    );

  const firstPage = await queryPage();
  assert.deepEqual(
    firstPage.entries.map((entry) => entry.id),
    expectedIds.slice(0, 2),
  );

  const utcSecondPage = await queryPage(
    "2026-03-27T12:00:00.000Z",
    "aud_same_c",
  );
  const offsetSecondPage = await queryPage(
    "2026-03-27T13:00:00.000+01:00",
    "  aud_same_c  ",
  );
  assert.deepEqual(
    offsetSecondPage.entries.map((entry) => entry.id),
    utcSecondPage.entries.map((entry) => entry.id),
    "same-instant offset and UTC cursors must have identical timestamp/id tiebreaks",
  );
  assert.deepEqual(
    offsetSecondPage.entries.map((entry) => entry.id),
    expectedIds.slice(2, 4),
  );

  const thirdPage = await queryPage(
    "2026-03-27T13:00:00.000+01:00",
    "aud_same_a",
  );
  const receivedIds = [
    ...firstPage.entries,
    ...offsetSecondPage.entries,
    ...thirdPage.entries,
  ].map((entry) => entry.id);
  assert.deepEqual(receivedIds, expectedIds);
  assert.equal(new Set(receivedIds).size, receivedIds.length);
}

async function assertRejectsMisalignedArchiveCursors(
  storage: ReturnType<typeof createSqliteStorage>,
) {
  const variants: AuditArchivePartitionCursor[] = [
    {
      kind: "archive_partition",
      orgId: "org_audit_cursor",
      timestamp: "2026-03-27T12:00:59.000Z",
      filterKey: "storage-contract-test",
    },
    {
      kind: "archive_partition",
      orgId: "org_audit_cursor",
      timestamp: "2026-03-27T13:00:00.001+01:00",
      inclusive: true,
      filterKey: "storage-contract-test",
    },
    {
      kind: "archive_partition",
      orgId: "org_audit_cursor",
      timestamp: "2026-03-27T12:00:30.000Z",
      inclusive: true,
      chunk: { key: "chunk-2", sha256: "chunk-2-sha" },
      filterKey: "storage-contract-test",
    },
    {
      kind: "archive_partition",
      orgId: "org_audit_cursor",
      timestamp: "2026-03-27T12:00:00.250Z",
      entryCursor: {
        timestamp: "2026-03-27T11:59:59.999Z",
        id: "aud_entry",
      },
      filterKey: "storage-contract-test",
    },
  ];

  for (const cursor of variants) {
    await assert.rejects(
      () =>
        storage.audit.query({
          orgId: "org_audit_cursor",
          limit: 10,
          cursor,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_input");
        return true;
      },
    );
  }
}

async function assertOffsetRangeBoundaryParity(
  storage: ReturnType<typeof createSqliteStorage>,
) {
  await storage.audit.write({
    id: "aud_offset_range_boundary",
    action: "token.issued",
    identityId: "agent_offset_range_boundary",
    orgId: "org_offset_range_boundary",
    result: "allowed",
    timestamp: "2026-03-27T06:30:00.000Z",
  });

  for (const testCase of [
    {
      field: "from" as const,
      utc: "2026-03-27T06:30:00.000Z",
      offset: "2026-03-27T12:00:00.000+05:30",
      expectedIds: ["aud_offset_range_boundary"],
      expectedTokensIssued: 1,
    },
    {
      field: "to" as const,
      utc: "2026-03-27T06:30:00.000Z",
      offset: "2026-03-27T12:00:00.000+05:30",
      expectedIds: [],
      expectedTokensIssued: 0,
    },
  ]) {
    const utcQuery = { [testCase.field]: testCase.utc };
    const offsetQuery = { [testCase.field]: testCase.offset };
    const utcEntries = await storage.audit.query(
      {
        orgId: "org_offset_range_boundary",
        limit: 10,
        ...utcQuery,
      },
      { includeOverflowRow: false },
    );
    const offsetEntries = await storage.audit.query(
      {
        orgId: "org_offset_range_boundary",
        limit: 10,
        ...offsetQuery,
      },
      { includeOverflowRow: false },
    );

    assert.deepEqual(
      offsetEntries.entries.map((entry) => entry.id),
      utcEntries.entries.map((entry) => entry.id),
      `${testCase.field} offset boundary must equal UTC`,
    );
    assert.deepEqual(
      offsetEntries.entries.map((entry) => entry.id),
      testCase.expectedIds,
    );

    const utcCounts = await storage.audit.getActionCounts(
      "org_offset_range_boundary",
      utcQuery,
    );
    const offsetCounts = await storage.audit.getActionCounts(
      "org_offset_range_boundary",
      offsetQuery,
    );
    assert.deepEqual(
      offsetCounts.counts,
      utcCounts.counts,
      `${testCase.field} count boundary must equal UTC`,
    );
    assert.equal(
      offsetCounts.counts.tokensIssued,
      testCase.expectedTokensIssued,
    );
  }
}

test("TestSqliteAuditQuery rejects impossible archive timestamps before opening storage", async (t) => {
  const { dbPath, storage } = createTempStorage(t);

  for (const timestamp of [
    "2026-02-29T12:00:00.000Z",
    "2026-03-27T12:00:00.000+24:00",
  ]) {
    await assert.rejects(
      () =>
        storage.audit.query({
          orgId: "org_audit_cursor",
          limit: 10,
          cursor: {
            kind: "archive_partition",
            orgId: "org_audit_cursor",
            timestamp,
            inclusive: true,
            filterKey: "storage-contract-test",
          },
        }),
      (error: unknown) => {
        assert.equal(error instanceof RangeError, false);
        assert.ok(error instanceof StorageError);
        assert.equal(error.name, "StorageError");
        assert.equal(error.code, "invalid_input");
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.equal(
      existsSync(dbPath),
      false,
      "invalid archive cursors must not open the SQLite store",
    );
  }
});

test("TestSqliteAuditQuery applies the inclusive archive cursor minute bound", async (t) => {
  const { dbPath, storage } = createTempStorage(t);
  await assertInclusiveArchiveCursorQuery(storage);
  assert.equal(existsSync(dbPath), true, "expected the SQLite query path");
});

test("TestSqliteAuditQuery applies the inclusive archive cursor minute bound in memory", async (t) => {
  const storage = createForcedMemoryStorage(t);
  await assertInclusiveArchiveCursorQuery(storage);
});

test("TestSqliteAuditQuery normalizes offset archive cursor boundaries", async (t) => {
  const { storage } = createTempStorage(t);
  await assertOffsetArchiveCursorParity(storage);
});

test("TestSqliteAuditQuery normalizes offset archive cursor boundaries in forced memory", async (t) => {
  const storage = createForcedMemoryStorage(t);
  await assertOffsetArchiveCursorParity(storage);
});

test("TestSqliteAuditQuery normalizes ordinary offset cursors without pagination gaps", async (t) => {
  const { storage } = createTempStorage(t);
  await assertOffsetEntryCursorPagination(storage);
});

test("TestSqliteAuditQuery normalizes ordinary offset cursors without pagination gaps in forced memory", async (t) => {
  const storage = createForcedMemoryStorage(t);
  await assertOffsetEntryCursorPagination(storage);
});

test("TestSqliteAuditQuery rejects non-minute archive cursor variants", async (t) => {
  const { storage } = createTempStorage(t);
  await assertRejectsMisalignedArchiveCursors(storage);
});

test("TestSqliteAuditQuery rejects non-minute archive cursor variants in forced memory", async (t) => {
  const storage = createForcedMemoryStorage(t);
  await assertRejectsMisalignedArchiveCursors(storage);
});

test("TestSqliteAuditQuery normalizes offset from/to query and count boundaries", async (t) => {
  const { storage } = createTempStorage(t);
  await assertOffsetRangeBoundaryParity(storage);
});

test("TestSqliteAuditQuery normalizes offset from/to query and count boundaries in forced memory", async (t) => {
  const storage = createForcedMemoryStorage(t);
  await assertOffsetRangeBoundaryParity(storage);
});

test("audit continuation filter keys canonicalize offset from/to boundaries", () => {
  const utcRange = {
    from: "2026-03-27T06:30:00.000Z",
    to: "2026-03-27T07:30:00.000Z",
  };
  const offsetRange = {
    from: "2026-03-27T12:00:00.000+05:30",
    to: "2026-03-27T13:00:00.000+05:30",
  };

  assert.equal(
    createAuditQueryContinuationFilterKey({ ...offsetRange, limit: 10 }),
    createAuditQueryContinuationFilterKey({ ...utcRange, limit: 10 }),
  );
  assert.equal(
    createDashboardAuditContinuationFilterKey(offsetRange),
    createDashboardAuditContinuationFilterKey(utcRange),
  );
});

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

  const suspended = await storage.identities.suspend(
    created.id,
    "manual_review",
  );
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

  await storage.revocations.revoke(
    "jti_revoked",
    Math.floor(Date.now() / 1000) + 3600,
  );

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
  assert.deepEqual(updated.scopes, [
    "relayauth:role:manage:*",
    "relayauth:role:read:*",
  ]);

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
  assert.deepEqual(updated.conditions, [
    { type: "ip", operator: "eq", value: "203.0.113.10" },
  ]);

  await storage.policies.delete(created.id);

  assert.equal(await storage.policies.get(created.id), null);
  assert.deepEqual(
    await storage.policies.list("org_policies", "ws_policies"),
    [],
  );
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
      metadata: {
        sponsorId: "user_audit",
        sponsorChain: '["user_audit","agent_audit_1"]',
      },
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
      metadata: {
        sponsorId: "user_audit",
        sponsorChain: '["user_audit","agent_audit_1"]',
      },
      ip: "203.0.113.10",
      userAgent: "node:test",
      timestamp: "2026-03-27T12:30:00.000Z",
    },
  ];

  for (const entry of entries) {
    await storage.audit.write(entry);
  }

  const byOrg = await storage.audit.query({ orgId: "org_audit", limit: 10 });
  assert.equal(byOrg.entries.length, 2);
  assert.equal(byOrg.entries[0]?.action, "identity.updated");
  assert.equal(byOrg.entries[1]?.action, "identity.created");

  const byTimeRange = await storage.audit.query({
    orgId: "org_audit",
    from: "2026-03-27T12:15:00.000Z",
    to: "2026-03-27T12:45:00.000Z",
    limit: 10,
  });
  assert.equal(byTimeRange.entries.length, 1);
  assert.equal(byTimeRange.entries[0]?.action, "identity.updated");
});

test("TestSqliteAutoCreateTables", async (t) => {
  const { dbPath, storage } = createTempStorage(t);

  const result = await storage.DB.prepare(
    `
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `,
  ).all<{ name?: string }>();
  const tables = result.results ?? [];

  assert.equal(existsSync(dbPath), true);

  const tableNames = new Set(
    tables
      .filter(
        (row): row is { name: string } =>
          typeof row.name === "string" && row.name.length > 0,
      )
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
    assert.equal(
      tableNames.has(tableName),
      true,
      `expected ${tableName} to be auto-created`,
    );
  }
});

test("TestSqliteAuditRetentionDefaultsToTwoDays", async (t) => {
  const { storage } = createTempStorage(t);

  await storage.DB.prepare(
    "INSERT INTO audit_retention_config (org_id) VALUES (?)",
  )
    .bind("org_default_retention")
    .run();

  const row = await storage.DB.prepare(
    "SELECT retention_days FROM audit_retention_config WHERE org_id = ?",
  )
    .bind("org_default_retention")
    .first<{ retention_days?: number }>();

  assert.equal(row?.retention_days, 2);
});
