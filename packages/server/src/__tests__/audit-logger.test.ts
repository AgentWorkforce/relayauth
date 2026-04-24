import assert from "node:assert/strict";
import test from "node:test";
import type { AuditAction, AuditEntry, RelayAuthTokenClaims } from "@relayauth/types";
import { Hono, type MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import {
  createTestRequest,
  generateTestToken,
  TEST_RS256_PRIVATE_KEY_PEM,
  TEST_RS256_PUBLIC_KEY_PEM,
} from "./test-helpers.js";

type ExtendedAuditAction =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

type AuditEntryInput = Omit<AuditEntry, "id" | "timestamp" | "action"> & {
  action: ExtendedAuditAction;
  timestamp?: string;
};

type AuditLoggerModule = {
  writeAuditEntry: (db: D1Database, entry: Partial<AuditEntryInput>) => Promise<void> | void;
  flushAuditBatch: (db: D1Database, entries: Partial<AuditEntryInput>[]) => Promise<void> | void;
  createAuditMiddleware: () => MiddlewareHandler<AppEnv>;
};

type RecordedStatement = {
  query: string;
  params: unknown[];
};

type RecordingD1 = {
  db: D1Database;
  runs: RecordedStatement[];
  batchCalls: RecordedStatement[][];
};

type RecordingD1Options = {
  failOnRun?: boolean;
  failOnBatch?: boolean;
};

type MetadataRecord = Record<string, string>;

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createBindings(overrides: Partial<AppEnv["Bindings"]> = {}): AppEnv["Bindings"] {
  return {
    INTERNAL_SECRET: "internal-test-secret",
    RELAYAUTH_SIGNING_KEY_PEM: TEST_RS256_PRIVATE_KEY_PEM,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: TEST_RS256_PUBLIC_KEY_PEM,
    ...overrides,
  };
}

function createRecordingD1(options: RecordingD1Options = {}): RecordingD1 {
  const runs: RecordedStatement[] = [];
  const batchCalls: RecordedStatement[][] = [];
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => {
      const bound = {
        __query: normalizeSql(query),
        __params: [...params],
        first: async <T>() => null as T | null,
        raw: async <T>() => [] as T[],
        all: async <T>() => ({
          results: [] as T[],
          success: true,
          meta,
        }),
        run: async () => {
          if (options.failOnRun) {
            throw new Error("simulated D1 write failure");
          }

          runs.push({
            query: normalizeSql(query),
            params: [...params],
          });

          return {
            success: true,
            meta,
          };
        },
      };

      return bound as unknown as D1PreparedStatement;
    },
    first: async <T>() => null as T | null,
    raw: async <T>() => [] as T[],
    all: async <T>() => ({
      results: [] as T[],
      success: true,
      meta,
    }),
    run: async () => {
      if (options.failOnRun) {
        throw new Error("simulated D1 write failure");
      }

      runs.push({
        query: normalizeSql(query),
        params: [],
      });

      return {
        success: true,
        meta,
      };
    },
  });

  return {
    runs,
    batchCalls,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const recorded = statements.map((statement) => {
          const candidate = statement as D1PreparedStatement & {
            __query?: string;
            __params?: unknown[];
          };

          return {
            query: candidate.__query ?? "",
            params: candidate.__params ?? [],
          };
        });

        batchCalls.push(recorded);

        if (options.failOnBatch) {
          throw new Error("simulated D1 batch failure");
        }

        return Promise.all(statements.map((statement) => statement.run())) as Awaited<T>;
      },
      exec: async () => ({
        count: 0,
        duration: 0,
      }),
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

type RecordingAuditStorage = {
  storage: { audit: { write: (entry: unknown) => Promise<void>; writeBatch: (entries: unknown[]) => Promise<void> } };
  writes: unknown[];
};

function createRecordingAuditStorage(): RecordingAuditStorage {
  const writes: unknown[] = [];
  return {
    storage: {
      audit: {
        write: async (entry: unknown) => { writes.push(entry); },
        writeBatch: async (entries: unknown[]) => { entries.forEach(e => writes.push(e)); },
      },
    },
    writes,
  };
}

async function loadAuditLogger(): Promise<AuditLoggerModule> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../engine/audit-logger.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected audit logger module at ../engine/audit-logger.js: ${message}`);
  }

  assert.equal(typeof moduleRecord.writeAuditEntry, "function", "audit logger should export writeAuditEntry()");
  assert.equal(typeof moduleRecord.flushAuditBatch, "function", "audit logger should export flushAuditBatch()");
  assert.equal(
    typeof moduleRecord.createAuditMiddleware,
    "function",
    "audit logger should export createAuditMiddleware()",
  );

  return moduleRecord as unknown as AuditLoggerModule;
}

function createBudgetExceededEntry(
  overrides: Partial<AuditEntryInput> = {},
): Partial<AuditEntryInput> {
  return {
    action: "budget.exceeded",
    identityId: "agent_budget_1",
    orgId: "org_budget_1",
    workspaceId: "ws_budget_1",
    plane: "relaycast",
    resource: "channel:#billing",
    result: "denied",
    metadata: {
      sponsorId: "user_sponsor_1",
      sponsorChain: JSON.stringify(["user_sponsor_1", "agent_root_1", "agent_budget_1"]),
      budgetConfig: JSON.stringify({
        maxActionsPerHour: 10,
        maxCostPerDay: 50,
        autoSuspend: true,
      }),
      actualUsage: JSON.stringify({
        actionsThisHour: 11,
        costToday: 63.5,
      }),
      actionAttempted: "relaycast:channel:write:#billing",
      ...overrides.metadata,
    },
    ...overrides,
  };
}

function createAuditAlertEntry(
  action: "budget.alert" | "scope.escalation_denied",
  overrides: Partial<AuditEntryInput> = {},
): Partial<AuditEntryInput> {
  return {
    action,
    identityId: overrides.identityId ?? "agent_alert_1",
    orgId: overrides.orgId ?? "org_alert_1",
    workspaceId: overrides.workspaceId ?? "ws_alert_1",
    plane: overrides.plane ?? "relaycast",
    resource: overrides.resource ?? "channel:#ops",
    result: overrides.result ?? (action === "scope.escalation_denied" ? "denied" : "allowed"),
    metadata: {
      sponsorId: "user_sponsor_2",
      sponsorChain: JSON.stringify(["user_sponsor_2", "agent_parent_2", overrides.identityId ?? "agent_alert_1"]),
      budgetConfig: JSON.stringify({
        maxActionsPerHour: 100,
        maxCostPerDay: 250,
      }),
      actualUsage: JSON.stringify({
        actionsThisHour: 90,
        costToday: 200,
      }),
      actionAttempted:
        action === "scope.escalation_denied"
          ? "relaycast:workspace:admin:*"
          : "relaycast:channel:write:#ops",
      reason:
        action === "scope.escalation_denied"
          ? "requested scope exceeded delegated grant"
          : "budget threshold approaching",
      ...overrides.metadata,
    },
    ...overrides,
  };
}

async function expectFailure(
  action: () => Promise<void> | void,
  expectedMessage: RegExp,
): Promise<void> {
  try {
    await action();
    assert.fail(`Expected operation to fail with ${expectedMessage}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, expectedMessage);
  }
}

function findAuditWrite(statements: RecordedStatement[]): RecordedStatement {
  const statement = statements.find(({ query }) => /insert into audit_log(s)?/.test(query));
  assert.ok(statement, "expected an INSERT into audit_log or audit_logs");
  return statement;
}

function findAuditId(params: unknown[]): string {
  const auditId = params.find(
    (param): param is string => typeof param === "string" && /^aud_[A-Za-z0-9_-]+$/.test(param),
  );

  assert.ok(auditId, "expected a generated audit id with aud_ prefix");
  return auditId;
}

function findIsoTimestamp(params: unknown[]): string {
  const timestamp = params.find(
    (param): param is string =>
      typeof param === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(param),
  );

  assert.ok(timestamp, "expected a generated ISO 8601 timestamp");
  return timestamp;
}

function findMetadata(params: unknown[]): MetadataRecord {
  for (const param of params) {
    if (typeof param !== "string" || !param.trim().startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(param) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "sponsorId" in parsed &&
        "sponsorChain" in parsed
      ) {
        return parsed as MetadataRecord;
      }
    } catch {
      // Ignore non-JSON string params.
    }
  }

  assert.fail("expected serialized metadata containing sponsorId and sponsorChain");
}

function createAuthorizationHeader(claims: Partial<RelayAuthTokenClaims> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${generateTestToken(claims)}`,
  };
}

test("writeAuditEntry() writes budget breach entries with sponsor and budget metadata", async () => {
  const { writeAuditEntry } = await loadAuditLogger();
  const { storage, writes } = createRecordingAuditStorage();
  const entry = createBudgetExceededEntry();

  await writeAuditEntry(storage, entry);

  assert.equal(writes.length, 1, "expected one audit write");
  const write = writes[0] as Record<string, unknown>;
  assert.equal(write.action, "budget.exceeded", "expected the budget.exceeded action");
  assert.equal(write.identityId, "agent_budget_1", "expected the entry identity id");
  assert.equal(write.orgId, "org_budget_1", "expected the entry org id");
  assert.equal(write.result, "denied", "expected the entry result");

  const metadata = (write.metadata ?? {}) as MetadataRecord;
  assert.equal(metadata.sponsorId, "user_sponsor_1");
  assert.deepEqual(JSON.parse(metadata.sponsorChain), [
    "user_sponsor_1",
    "agent_root_1",
    "agent_budget_1",
  ]);
  assert.deepEqual(JSON.parse(metadata.budgetConfig), {
    maxActionsPerHour: 10,
    maxCostPerDay: 50,
    autoSuspend: true,
  });
  assert.deepEqual(JSON.parse(metadata.actualUsage), {
    actionsThisHour: 11,
    costToday: 63.5,
  });
  assert.equal(metadata.actionAttempted, "relaycast:channel:write:#billing");
});

test("writeAuditEntry() generates a unique audit id and timestamp when they are not provided", async () => {
  const { writeAuditEntry } = await loadAuditLogger();
  const { storage, writes } = createRecordingAuditStorage();

  await writeAuditEntry(storage, createBudgetExceededEntry({ identityId: "agent_budget_1a" }));
  await writeAuditEntry(storage, createBudgetExceededEntry({ identityId: "agent_budget_1b" }));

  assert.equal(writes.length, 2, "expected two writes");

  const first = writes[0] as Record<string, unknown>;
  const second = writes[1] as Record<string, unknown>;

  assert.ok(typeof first.id === "string" && first.id.length > 0, "expected a generated id");
  assert.ok(typeof second.id === "string" && second.id.length > 0, "expected a generated id");
  assert.notEqual(first.id, second.id, "expected unique generated ids");
  assert.equal(Number.isNaN(Date.parse(first.timestamp as string)), false, "expected a valid timestamp");
  assert.equal(Number.isNaN(Date.parse(second.timestamp as string)), false, "expected a valid timestamp");
});

test("writeAuditEntry() validates required fields and sponsor trace metadata", async (t) => {
  const { writeAuditEntry } = await loadAuditLogger();

  await t.test("requires action", async () => {
    const { db, runs } = createRecordingD1();
    await expectFailure(
      () => writeAuditEntry(db, { ...createBudgetExceededEntry(), action: undefined }),
      /action/i,
    );
    assert.equal(runs.length, 0);
  });

  await t.test("requires identityId", async () => {
    const { db, runs } = createRecordingD1();
    await expectFailure(
      () => writeAuditEntry(db, { ...createBudgetExceededEntry(), identityId: undefined }),
      /identity/i,
    );
    assert.equal(runs.length, 0);
  });

  await t.test("requires orgId", async () => {
    const { db, runs } = createRecordingD1();
    await expectFailure(
      () => writeAuditEntry(db, { ...createBudgetExceededEntry(), orgId: undefined }),
      /org/i,
    );
    assert.equal(runs.length, 0);
  });

  await t.test("requires result", async () => {
    const { db, runs } = createRecordingD1();
    await expectFailure(
      () => writeAuditEntry(db, { ...createBudgetExceededEntry(), result: undefined }),
      /result/i,
    );
    assert.equal(runs.length, 0);
  });

  await t.test("requires metadata.sponsorId", async () => {
    const { db, runs } = createRecordingD1();
    const entry = createBudgetExceededEntry();
    delete entry.metadata?.sponsorId;

    await expectFailure(() => writeAuditEntry(db, entry), /sponsorid/i);
    assert.equal(runs.length, 0);
  });

  await t.test("requires metadata.sponsorChain", async () => {
    const { db, runs } = createRecordingD1();
    const entry = createBudgetExceededEntry();
    delete entry.metadata?.sponsorChain;

    await expectFailure(() => writeAuditEntry(db, entry), /sponsorchain/i);
    assert.equal(runs.length, 0);
  });
});

test("createAuditMiddleware() logs token validation events automatically", async () => {
  const { createAuditMiddleware } = await loadAuditLogger();
  const sqliteStorage = createSqliteStorage(":memory:");
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("storage", sqliteStorage);
    await next();
  });
  app.use("*", createAuditMiddleware());
  app.get("/session", (c) => c.json({ ok: true }));

  const response = await app.request(
    createTestRequest(
      "GET",
      "/session",
      undefined,
      {
        ...createAuthorizationHeader({
          sub: "agent_middleware_1",
          org: "org_middleware_1",
          wks: "ws_middleware_1",
          scopes: ["relayauth:*"],
          sponsorId: "user_middleware_1",
          sponsorChain: ["user_middleware_1", "agent_root_1", "agent_middleware_1"],
          jti: "tok_middleware_1",
        }),
        "User-Agent": "audit-tests/1.0",
        "CF-Connecting-IP": "203.0.113.10",
      },
    ),
    undefined,
    createBindings(),
  );

  assert.equal(response.status, 200);

  // Query audit log from SQLite storage instead of D1 recording
  const auditEntries = await sqliteStorage.audit.query({ orgId: "org_middleware_1" });
  const entries = auditEntries.items ?? auditEntries;
  assert.ok(entries.length >= 1, "expected a token validation audit write");

  const tokenValidated = entries.find((e: any) => e.action === "token.validated");
  assert.ok(tokenValidated, "expected token.validated audit action");
  assert.equal(tokenValidated.identityId, "agent_middleware_1", "expected request identity id");
  assert.equal(tokenValidated.orgId, "org_middleware_1", "expected request org id");

  const metadata = typeof tokenValidated.metadata === "string" ? JSON.parse(tokenValidated.metadata) : (tokenValidated.metadata ?? {});
  assert.equal(metadata.sponsorId, "user_middleware_1");
  assert.deepEqual(JSON.parse(metadata.sponsorChain ?? "[]"), [
    "user_middleware_1",
    "agent_root_1",
    "agent_middleware_1",
  ]);
  assert.equal(metadata.tokenId, "tok_middleware_1");
});

test("flushAuditBatch() writes multiple audit entries", async () => {
  const { flushAuditBatch } = await loadAuditLogger();
  const { storage, writes } = createRecordingAuditStorage();

  await flushAuditBatch(storage, [
    createAuditAlertEntry("budget.alert"),
    createAuditAlertEntry("scope.escalation_denied", {
      identityId: "agent_scope_1",
      orgId: "org_scope_1",
      result: "denied",
      metadata: {
        sponsorId: "user_scope_1",
        sponsorChain: JSON.stringify(["user_scope_1", "agent_parent_2", "agent_scope_1"]),
        actionAttempted: "relaycast:workspace:admin:*",
        budgetConfig: JSON.stringify({ maxActionsPerHour: 100 }),
        actualUsage: JSON.stringify({ actionsThisHour: 101 }),
        reason: "requested scope exceeded delegated grant",
      },
    }),
  ]);

  assert.equal(writes.length, 2, "expected both entries to be written");

  const actions = writes.map((w) => (w as Record<string, unknown>).action);
  assert.equal(actions.includes("budget.alert"), true, "expected support for the new budget.alert action");
  assert.equal(actions.includes("scope.escalation_denied"), true, "expected support for scope.escalation_denied");

  const alertEntry = writes.find((w) => (w as Record<string, unknown>).action === "budget.alert") as Record<string, unknown>;
  const escalationEntry = writes.find((w) => (w as Record<string, unknown>).action === "scope.escalation_denied") as Record<string, unknown>;

  const alertMetadata = (alertEntry.metadata ?? {}) as MetadataRecord;
  const escalationMetadata = (escalationEntry.metadata ?? {}) as MetadataRecord;

  assert.equal(alertMetadata.sponsorId, "user_sponsor_2");
  assert.deepEqual(JSON.parse(alertMetadata.sponsorChain), [
    "user_sponsor_2",
    "agent_parent_2",
    "agent_alert_1",
  ]);
  assert.equal(escalationMetadata.sponsorId, "user_scope_1");
  assert.deepEqual(JSON.parse(escalationMetadata.sponsorChain), [
    "user_scope_1",
    "agent_parent_2",
    "agent_scope_1",
  ]);
  assert.equal(escalationMetadata.actionAttempted, "relaycast:workspace:admin:*");
});

test("writeAuditEntry() handles D1 write failures gracefully by logging the error and not throwing", async (t) => {
  const { writeAuditEntry } = await loadAuditLogger();
  const { db } = createRecordingD1({
    failOnRun: true,
    failOnBatch: true,
  });
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  t.after(() => {
    console.error = originalConsoleError;
  });

  await assert.doesNotReject(async () => {
    await writeAuditEntry(db, createBudgetExceededEntry());
  });

  assert.equal(errors.length > 0, true, "expected write failures to be logged");
  assert.match(
    errors
      .flat()
      .map((value) => String(value))
      .join(" "),
    /audit|d1|write/i,
  );
});
