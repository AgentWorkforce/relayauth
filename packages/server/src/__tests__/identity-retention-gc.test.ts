import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  countStaleIdentitiesBatch,
  MAX_GC_WINDOW_SIZE,
  MAX_IDENTITY_RETENTION_DAYS,
  MIN_IDENTITY_RETENTION_DAYS,
  pruneStaleIdentitiesWindow,
  scanStaleIdentitiesWindow,
  type RetentionGcCursorSqlExecutor,
  type RetentionGcSqlExecutor,
} from "../engine/retention-gc.js";
import { createSqliteStorage, type SqliteStorage } from "../storage/sqlite.js";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
// Far-future expiry used by the indefinite durable token class (#90). It is a
// real timestamp rather than NULL, so a MAX/comparison liveness guard must
// treat it as live without any special case.
const INDEFINITE_ACCESS_TOKEN_EXP = Math.floor(
  Date.parse("2100-01-01T00:00:00.000Z") / 1_000,
);

function createStorage(t: TestContext): {
  storage: SqliteStorage;
  db: RetentionGcSqlExecutor & RetentionGcCursorSqlExecutor;
} {
  const storage = createSqliteStorage(":memory:");
  t.after(async () => storage.close());
  return {
    storage,
    db: storage.DB as unknown as RetentionGcSqlExecutor & RetentionGcCursorSqlExecutor,
  };
}

function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

type IdentityFixture = {
  id: string;
  orgId?: string;
  name?: string;
  workspaceId?: string;
  sponsorId?: string;
  createdAt?: string;
  lastActiveAt?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | string;
  rowid?: number;
};

async function insertIdentity(
  storage: SqliteStorage,
  fixture: IdentityFixture,
): Promise<void> {
  const orgId = fixture.orgId ?? "org_sprawl";
  const name = fixture.name ?? fixture.id;
  const createdAt = fixture.createdAt ?? daysBeforeNow(90);
  const metadata = typeof fixture.metadata === "string"
    ? fixture.metadata
    : JSON.stringify(fixture.metadata ?? {});

  await storage.DB.prepare(
    `
      INSERT INTO identities (
        rowid, id, data, name, type, org_id, workspace_id, sponsor_id,
        sponsor_chain_json, scopes_json, roles_json, status, metadata_json,
        created_at, updated_at, last_active_at
      )
      VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      fixture.rowid ?? null,
      fixture.id,
      JSON.stringify({ id: fixture.id, name }),
      name,
      orgId,
      fixture.workspaceId ?? "ws_sprawl",
      fixture.sponsorId ?? "user_sponsor",
      JSON.stringify([fixture.sponsorId ?? "user_sponsor", fixture.id]),
      fixture.status ?? "active",
      metadata,
      createdAt,
      createdAt,
      fixture.lastActiveAt ?? null,
    )
    .run();
}

/**
 * `createdAt` defaults to OUTSIDE the retention window. A token issued inside
 * the window pins its identity on its own (see the recently-issued clause in
 * retention-gc.ts), which would mask what most of these tests are actually
 * about: whether the token is LIVE. Tests that mean to exercise recency pass an
 * explicit recent `createdAt`.
 */
const AGED_TOKEN_CREATED_AT = new Date(
  NOW.getTime() - 90 * 24 * 60 * 60 * 1000,
).toISOString();

async function insertToken(
  storage: SqliteStorage,
  id: string,
  identityId: string,
  expiresAt: number | null,
  status = "active",
  createdAt: string = AGED_TOKEN_CREATED_AT,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO tokens (id, token_id, jti, identity_id, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(id, id, id, identityId, expiresAt, status, createdAt)
    .run();
}

async function insertLineage(
  storage: SqliteStorage,
  tokenId: string,
  identityId: string,
  createdAt: string,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO token_lineages (
        token_id, issued_token_id, identity_id, org_id, workspace_id,
        sponsor_id, token_type, created_at
      )
      VALUES (?, ?, ?, 'org_sprawl', 'ws_sprawl', 'sponsor', 'access', ?)
    `,
  )
    .bind(tokenId, tokenId, identityId, createdAt)
    .run();
}

async function enableRetention(
  storage: SqliteStorage,
  orgId: string,
  retentionDays: number,
  enabled = 1,
): Promise<void> {
  await storage.DB.prepare(
    `
      INSERT INTO identity_retention_config (org_id, retention_days, enabled)
      VALUES (?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE
      SET retention_days = excluded.retention_days, enabled = excluded.enabled
    `,
  )
    .bind(orgId, retentionDays, enabled)
    .run();
}

async function readIdentityIds(storage: SqliteStorage): Promise<string[]> {
  const result = await storage.DB.prepare(
    "SELECT id FROM identities ORDER BY id ASC",
  ).all<{ id: string }>();
  return result.results.map((row) => row.id);
}

/** Runs one full scan -> prune cycle and returns how many rows it deleted. */
async function sweepOnce(
  db: RetentionGcSqlExecutor & RetentionGcCursorSqlExecutor,
  options: { cursor?: number; limit?: number } = {},
): Promise<{ deletedCount: number; cursorAfter: number; exhausted: boolean }> {
  const window = await scanStaleIdentitiesWindow(db, { ...options, now: NOW });
  const pruned = await pruneStaleIdentitiesWindow(db, window, { now: NOW });
  return {
    deletedCount: pruned.deletedCount,
    cursorAfter: window.cursorAfter,
    exhausted: window.exhausted,
  };
}

/**
 * Wraps the executor so `mutate` runs exactly once, immediately after the next
 * bounded identity window scan resolves and before the caller can prune it.
 * This reproduces the real scheduler race: rows can become live between the
 * scan that nominated them and the DELETE that acts on that evidence.
 */
function mutateAfterNextWindowScan(
  storage: SqliteStorage,
  mutate: () => Promise<void>,
): RetentionGcCursorSqlExecutor & RetentionGcSqlExecutor {
  let mutated = false;

  return {
    prepare(sql: string) {
      const prepared = storage.DB.prepare(sql);
      const maybeMutate = async <T>(result: { results?: T[]; meta?: unknown }) => {
        if (
          !mutated &&
          /\bFROM\s+identities\b/i.test(sql) &&
          /ORDER BY/i.test(sql) &&
          /LIMIT/i.test(sql)
        ) {
          mutated = true;
          await mutate();
        }
        return result;
      };

      return {
        bind(...params: unknown[]) {
          const bound = prepared.bind(...params);
          return {
            bind: () => {
              throw new Error("unexpected second bind");
            },
            all: async <T>() => maybeMutate(await bound.all<T>()),
            run: () => bound.run(),
            first: <T>() => bound.first<T>(),
          };
        },
        all: async <T>() => maybeMutate(await prepared.all<T>()),
        run: () => prepared.run(),
        first: <T>() => prepared.first<T>(),
      };
    },
  } as RetentionGcCursorSqlExecutor & RetentionGcSqlExecutor;
}

test("an aged identity with no live token is swept once its org opts in", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_stale", createdAt: daysBeforeNow(90) });
  await insertIdentity(storage, { id: "agent_fresh", createdAt: daysBeforeNow(1) });
  // Expired and revoked tokens can never pass verification again, so neither
  // pins its identity.
  await insertToken(storage, "tok_expired", "agent_stale", NOW_SECONDS - 86_400);
  await insertToken(storage, "tok_revoked", "agent_stale", NOW_SECONDS + 86_400, "revoked");

  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 1,
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_fresh"]);
});

test("a live access token blocks identity retention", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_live" });
  await insertIdentity(storage, { id: "agent_grace" });
  await insertIdentity(storage, { id: "agent_drained" });
  await insertToken(storage, "tok_live", "agent_live", NOW_SECONDS + 3_600);
  // Inside the verifier's accepted clock skew: still usable, still live.
  await insertToken(storage, "tok_grace", "agent_grace", NOW_SECONDS - 30);
  await insertToken(storage, "tok_dead", "agent_drained", NOW_SECONDS - 3_600);

  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 1,
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_grace", "agent_live"]);
});

test("a NULL expires_at token is treated as live and blocks retention", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_null_exp" });
  await insertIdentity(storage, { id: "agent_indefinite" });
  await insertIdentity(storage, { id: "agent_drained" });
  // Legacy rows predate the expiry column being populated. Their liveness is
  // unknowable from storage, so they must fail safe as live.
  await insertToken(storage, "tok_null", "agent_null_exp", null);
  // The indefinite durable token class (#90) uses a far-future exp rather than
  // NULL; the same comparison has to protect it.
  await insertToken(
    storage,
    "tok_indefinite",
    "agent_indefinite",
    INDEFINITE_ACCESS_TOKEN_EXP,
  );
  await insertToken(storage, "tok_dead", "agent_drained", NOW_SECONDS - 3_600);

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), [
    "agent_indefinite",
    "agent_null_exp",
  ]);
});

test("an identity that still sponsors a surviving identity is retained", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_sponsor" });
  await insertIdentity(storage, {
    id: "agent_child",
    sponsorId: "agent_sponsor",
  });
  await insertToken(storage, "tok_child_live", "agent_child", NOW_SECONDS + 3_600);
  await insertIdentity(storage, { id: "agent_orphan" });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), [
    "agent_child",
    "agent_sponsor",
  ]);

  // Once the child drains, the sponsor becomes collectable — but only on a
  // later sweep. Containment is evaluated against the rows the scan observed,
  // so a sponsor chain unwinds one level per sweep rather than all at once.
  await storage.DB.prepare("DELETE FROM tokens WHERE id = ?").bind("tok_child_live").run();
  const second = await sweepOnce(db);
  assert.equal(second.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_sponsor"]);

  const third = await sweepOnce(db);
  assert.equal(third.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), []);
});

test("sponsor containment is scoped to the organization", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_sponsor", orgId: "org_sprawl" });
  // A same-named sponsor reference in a different org must not pin this row.
  await insertIdentity(storage, {
    id: "agent_foreign_child",
    orgId: "org_other",
    sponsorId: "agent_sponsor",
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_foreign_child"]);
});

test("a row that becomes live between scan and prune survives the window", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_races" });
  await insertIdentity(storage, { id: "agent_drains" });

  const racingDb = mutateAfterNextWindowScan(storage, async () => {
    await insertToken(storage, "tok_raced", "agent_races", NOW_SECONDS + 3_600);
  });

  const window = await scanStaleIdentitiesWindow(racingDb, { now: NOW });
  assert.deepEqual([...window.candidateIds].sort(), ["agent_drains", "agent_races"]);

  const pruned = await pruneStaleIdentitiesWindow(racingDb, window, { now: NOW });
  assert.equal(pruned.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_races"]);
});

test("a row that gains a sponsored child between scan and prune survives", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_becomes_sponsor" });

  const racingDb = mutateAfterNextWindowScan(storage, async () => {
    await insertIdentity(storage, {
      id: "agent_late_child",
      sponsorId: "agent_becomes_sponsor",
      createdAt: daysBeforeNow(0),
    });
  });

  const window = await scanStaleIdentitiesWindow(racingDb, { now: NOW });
  assert.deepEqual(window.candidateIds, ["agent_becomes_sponsor"]);

  const pruned = await pruneStaleIdentitiesWindow(racingDb, window, { now: NOW });
  assert.equal(pruned.deletedCount, 0);
  assert.deepEqual(await readIdentityIds(storage), [
    "agent_becomes_sponsor",
    "agent_late_child",
  ]);

  void db;
});

test("identity retention is off until an organization explicitly enables it", async (t) => {
  const { storage, db } = createStorage(t);

  // org_unconfigured has no row at all; org_disabled has one with enabled = 0,
  // which is the column default a plain upgrade produces.
  await insertIdentity(storage, { id: "agent_unconfigured", orgId: "org_unconfigured" });
  await insertIdentity(storage, { id: "agent_disabled", orgId: "org_disabled" });
  await enableRetention(storage, "org_disabled", 7, 0);

  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 0,
  });
  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 0);
  assert.deepEqual(await readIdentityIds(storage), [
    "agent_disabled",
    "agent_unconfigured",
  ]);
});

test("the enabled column defaults to off for rows inserted without it", async (t) => {
  const { storage, db } = createStorage(t);

  await storage.DB.prepare(
    "INSERT INTO identity_retention_config (org_id, retention_days) VALUES (?, ?)",
  )
    .bind("org_sprawl", 7)
    .run();
  await insertIdentity(storage, { id: "agent_default_off" });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 0);
  assert.deepEqual(await readIdentityIds(storage), ["agent_default_off"]);
});

test("malformed or out-of-range retention windows retain rather than delete", async (t) => {
  const { storage, db } = createStorage(t);

  await storage.DB.prepare(
    `
      INSERT INTO identity_retention_config (org_id, retention_days, enabled)
      VALUES (?, ?, 1), (?, ?, 1), (?, ?, 1)
    `,
  )
    .bind(
      "org_zero",
      MIN_IDENTITY_RETENTION_DAYS - 1,
      "org_huge",
      MAX_IDENTITY_RETENTION_DAYS + 1,
      "org_fractional",
      7.5,
    )
    .run();

  await insertIdentity(storage, { id: "agent_zero", orgId: "org_zero" });
  await insertIdentity(storage, { id: "agent_huge", orgId: "org_huge" });
  await insertIdentity(storage, { id: "agent_fractional", orgId: "org_fractional" });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 0);
  assert.equal((await readIdentityIds(storage)).length, 3);
});

test("retention honors the metadata opt-out and retains unreadable metadata", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, {
    id: "agent_pinned",
    metadata: { retention: "keep" },
  });
  await insertIdentity(storage, {
    id: "agent_other_metadata",
    metadata: { retention: "auto", owner: "platform" },
  });
  await insertIdentity(storage, { id: "agent_broken_metadata", metadata: "{not json" });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), [
    "agent_broken_metadata",
    "agent_pinned",
  ]);
});

test("recent activity retains an otherwise aged identity", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, {
    id: "agent_recently_active",
    createdAt: daysBeforeNow(90),
    lastActiveAt: daysBeforeNow(1),
  });
  await insertIdentity(storage, {
    id: "agent_long_idle",
    createdAt: daysBeforeNow(90),
    lastActiveAt: daysBeforeNow(60),
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_recently_active"]);
});

test("suspended and retired identities drain on the same age rule", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  // The sprawl rows stay status='active' forever because nothing retires them,
  // so retention must not key off a terminal status.
  await insertIdentity(storage, { id: "agent_active", status: "active" });
  await insertIdentity(storage, { id: "agent_suspended", status: "suspended" });
  await insertIdentity(storage, { id: "agent_retired", status: "retired" });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 3);
  assert.deepEqual(await readIdentityIds(storage), []);
});

test("identity windows advance a stable cursor and report exhaustion", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_a", rowid: 10 });
  await insertIdentity(storage, { id: "agent_b", rowid: 40 });
  await insertIdentity(storage, { id: "agent_c", rowid: 90 });
  await insertToken(storage, "tok_b_live", "agent_b", NOW_SECONDS + 3_600);

  const first = await scanStaleIdentitiesWindow(db, { now: NOW, limit: 2 });
  assert.equal(first.cursorBefore, 0);
  assert.equal(first.cursorAfter, 40);
  assert.equal(first.scannedCount, 2);
  assert.equal(first.exhausted, false);
  assert.deepEqual(first.candidateIds, ["agent_a"]);
  assert.equal((await pruneStaleIdentitiesWindow(db, first, { now: NOW })).deletedCount, 1);

  const second = await scanStaleIdentitiesWindow(db, {
    now: NOW,
    limit: 2,
    cursor: first.cursorAfter,
  });
  assert.equal(second.cursorAfter, 90);
  assert.equal(second.exhausted, true);
  assert.deepEqual(second.candidateIds, ["agent_c"]);
  assert.equal((await pruneStaleIdentitiesWindow(db, second, { now: NOW })).deletedCount, 1);

  const third = await scanStaleIdentitiesWindow(db, {
    now: NOW,
    limit: 2,
    cursor: second.cursorAfter,
  });
  assert.equal(third.scannedCount, 0);
  assert.equal(third.cursorAfter, second.cursorAfter);
  assert.equal(third.exhausted, true);
  assert.deepEqual(third.candidateIds, []);
  assert.equal((await pruneStaleIdentitiesWindow(db, third, { now: NOW })).deletedCount, 0);

  assert.deepEqual(await readIdentityIds(storage), ["agent_b"]);
});

test("identity windows delete only the exact ids their scan nominated", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_scanned", rowid: 5 });
  const window = await scanStaleIdentitiesWindow(db, { now: NOW, limit: 1 });
  assert.deepEqual(window.candidateIds, ["agent_scanned"]);

  // A different aged row that reuses the scanned rowid must not be swept by
  // evidence gathered before it existed.
  await storage.DB.prepare("DELETE FROM identities WHERE id = ?").bind("agent_scanned").run();
  await insertIdentity(storage, { id: "agent_replacement", rowid: 5 });

  const pruned = await pruneStaleIdentitiesWindow(db, window, { now: NOW });
  assert.equal(pruned.deletedCount, 0);
  assert.deepEqual(await readIdentityIds(storage), ["agent_replacement"]);
});

test("identity windows refuse malformed candidate evidence", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);
  await insertIdentity(storage, { id: "agent_a", rowid: 3 });

  await assert.rejects(
    () =>
      pruneStaleIdentitiesWindow(
        db,
        {
          cursorBefore: 0,
          cursorAfter: 3,
          scannedCount: 1,
          exhausted: true,
        } as never,
        { now: NOW },
      ),
    /candidateIds/,
  );

  await assert.rejects(
    () =>
      pruneStaleIdentitiesWindow(
        db,
        {
          cursorBefore: 0,
          cursorAfter: 3,
          scannedCount: 2,
          exhausted: true,
          candidateIds: ["agent_a", "agent_a"],
        },
        { now: NOW },
      ),
    /duplicates/,
  );

  assert.deepEqual(await readIdentityIds(storage), ["agent_a"]);
});

test("identity window size is capped at the steady-state bound", async (t) => {
  const { db } = createStorage(t);
  await assert.rejects(
    () => scanStaleIdentitiesWindow(db, { limit: MAX_GC_WINDOW_SIZE + 1 }),
    /limit must not exceed/,
  );
});

test("bounded identity counts never delete rows", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);
  await insertIdentity(storage, { id: "agent_stale" });

  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 1,
  });
  assert.deepEqual(await readIdentityIds(storage), ["agent_stale"]);
});

test("lineage survives identity retention as the historical record", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);
  await insertIdentity(storage, { id: "agent_stale", name: "deploy-bot" });

  const beforeLineage = await storage.DB.prepare(
    "SELECT identity_id FROM identity_lineages WHERE identity_id = ?",
  )
    .bind("agent_stale")
    .first<{ identity_id: string }>();
  assert.ok(beforeLineage, "migration 0008 records lineage on insert");

  assert.equal((await sweepOnce(db)).deletedCount, 1);

  const afterLineage = await storage.DB.prepare(
    "SELECT identity_id FROM identity_lineages WHERE identity_id = ?",
  )
    .bind("agent_stale")
    .first<{ identity_id: string }>();
  assert.ok(afterLineage, "lineage is retained after the identity row is swept");

  const members = await storage.DB.prepare(
    "SELECT principal_id FROM identity_lineage_members WHERE identity_id = ? ORDER BY chain_position",
  )
    .bind("agent_stale")
    .all<{ principal_id: string }>();
  assert.deepEqual(
    members.results.map((row) => row.principal_id),
    ["user_sponsor", "agent_stale"],
  );
});

test("workspace-agent revocation still resolves path tokens after identity retention", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  // The minting identity is drained; a path token minted under its agent name
  // is still live under a transient identity id. Migration 0010 persists the
  // agent name on token_lineages precisely so this keeps resolving.
  await insertIdentity(storage, { id: "agent_minter", name: "deploy-bot" });
  await insertToken(storage, "tok_path", "agent_path_transient", NOW_SECONDS + 3_600);
  await storage.DB.prepare(
    `
      INSERT INTO token_lineages (
        token_id, issued_token_id, identity_id, org_id, workspace_id,
        sponsor_id, token_type, created_at, agent_name
      )
      VALUES (?, ?, ?, ?, ?, ?, 'access', ?, ?)
    `,
  )
    .bind(
      "tok_path",
      "tok_path",
      "agent_path_transient",
      "org_sprawl",
      "ws_sprawl",
      "user_sponsor",
      NOW.toISOString(),
      "deploy-bot",
    )
    .run();

  assert.equal((await sweepOnce(db)).deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), []);

  assert.ok(storage.tokens.listActiveByWorkspaceAgent);
  const resolved = await storage.tokens.listActiveByWorkspaceAgent(
    "org_sprawl",
    "ws_sprawl",
    "deploy-bot",
    "agent_minter",
  );
  assert.deepEqual(resolved.map((token) => token.id), ["tok_path"]);
});

test("identity retention sweeps use rowid seeks and exact stable-id lookups", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);
  await insertIdentity(storage, { id: "agent_stale" });

  const explain = async (sql: string, params: unknown[]): Promise<string> => {
    const plan = await storage.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    return plan.results.map((row) => row.detail).join("\n");
  };

  const captured: { sql: string; params: unknown[] }[] = [];
  const capturingDb = {
    prepare(sql: string) {
      const prepared = storage.DB.prepare(sql);
      return {
        bind(...params: unknown[]) {
          captured.push({ sql, params });
          const bound = prepared.bind(...params);
          return {
            bind: () => {
              throw new Error("unexpected second bind");
            },
            all: <T>() => bound.all<T>(),
            run: () => bound.run(),
            first: <T>() => bound.first<T>(),
          };
        },
      };
    },
  } as unknown as RetentionGcCursorSqlExecutor & RetentionGcSqlExecutor;

  const window = await scanStaleIdentitiesWindow(capturingDb, { now: NOW });
  await pruneStaleIdentitiesWindow(capturingDb, window, { now: NOW });
  assert.equal(captured.length, 2);

  const scanPlan = await explain(captured[0].sql, captured[0].params);
  assert.match(scanPlan, /identities USING INTEGER PRIMARY KEY \(rowid>\?\)/);
  assert.match(scanPlan, /idx_tokens_identity_status/);
  assert.match(scanPlan, /idx_identities_org_sponsor/);

  const prunePlan = await explain(captured[1].sql, captured[1].params);
  assert.match(prunePlan, /identities USING INDEX sqlite_autoindex_identities_1/);
});

/**
 * Regression guard for the caller-reuse interaction (AgentWorkforce/cloud#3819).
 *
 * Once one identity is REUSED across mints it is old, its `last_active_at` is
 * NULL (only PATCH ever writes it), and between token expiries it has no live
 * token — matching every other eligibility clause while in daily use. Sweeping
 * it would leave the caller's durable mapping pointing at an identity that no
 * longer exists, and the caller has no way to notice.
 */
test("a recently issued but already expired token pins an aged identity", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_reused" });
  await insertIdentity(storage, { id: "agent_abandoned" });

  // Reused identity: its newest token has already expired, but it was issued
  // inside the retention window, so the identity is plainly still in service.
  await insertToken(
    storage,
    "tok_recent_expired",
    "agent_reused",
    NOW_SECONDS - 60,
    "active",
    NOW.toISOString(),
  );
  // Genuinely abandoned: last token both expired AND issued long ago.
  await insertToken(
    storage,
    "tok_old_expired",
    "agent_abandoned",
    NOW_SECONDS - 3_600,
  );

  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 1,
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), ["agent_reused"]);
});

/**
 * Cursor Bugbot, PR #93: "Token GC defeats reuse pin".
 *
 * The recency pin is worthless if it reads only a table the sibling sweep
 * empties. `pruneExpiredTokensWindow` deletes a token row once it expires, so
 * running the token sweep first strips that evidence.
 *
 * These two tests pin the lineage clause's BEHAVIOUR where lineage rows exist.
 * They do NOT demonstrate that a reused identity is protected in production:
 * `token_lineages` was empty there when this was written, because the Relayfile
 * mint path sets no lineage. See the eligibility comment in retention-gc.ts —
 * the durable protection is the caller re-resolving on 404, not this clause.
 */
test("the reuse pin survives the sibling token sweep, which deletes the token row", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_reused" });
  await insertLineage(storage, "tok_swept", "agent_reused", NOW.toISOString());

  // Exactly the post-token-sweep state: the lineage row remains, its token
  // row is gone.
  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 0,
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 0);
  assert.deepEqual(await readIdentityIds(storage), ["agent_reused"]);
});

test("an identity whose lineage is older than the window is still collectable", async (t) => {
  const { storage, db } = createStorage(t);
  await enableRetention(storage, "org_sprawl", 7);

  await insertIdentity(storage, { id: "agent_abandoned" });
  await insertLineage(storage, "tok_ancient", "agent_abandoned", AGED_TOKEN_CREATED_AT);

  assert.deepEqual(await countStaleIdentitiesBatch(db, { now: NOW }), {
    expiredCount: 1,
  });

  const swept = await sweepOnce(db);
  assert.equal(swept.deletedCount, 1);
  assert.deepEqual(await readIdentityIds(storage), []);
});
