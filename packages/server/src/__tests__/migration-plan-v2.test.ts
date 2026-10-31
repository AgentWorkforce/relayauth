/**
 * PROTOTYPE tests for plan entry v2 (96BullSessions #79 data contract,
 * #86 issuer spec, which is on contract-review HOLD). The vectors are a
 * verbatim copy of #79 @ c91f4ac0's relayhistory-export-plan-entry-v2.vectors.json.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalMigrationJson,
  deriveMigrationGrantPlan,
  MAX_MIGRATION_GRANT_ENTRIES,
  MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY,
  migrationBackfillBaseReadIdentity,
  migrationBackfillUploadIdentity,
  MigrationPlanError,
  migrationSha256,
  normalizeMigrationBackfillBase,
  verifyStoredMigrationGrantPlan,
  type MigrationBackfillEntry,
  type MigrationGrantPlan,
} from "../lib/migration-plan.js";

type Json = Record<string, any>;
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/relayhistory-export-plan-entry-v2.vectors.json", import.meta.url),
    "utf8",
  ),
) as Json;

const GRANT_ID: string = vectors.grant_id;
const ORG = "org_synthetic";
const V1_DIGEST = "a6682d4deeb479a42d8abf4c0dae89ddf39744916a0d4148bdb40ec702c20df1";

/** The two contract-v1 manifests, as a client sends them. */
function v1ManifestInputs(): Json[] {
  const stored = JSON.parse(vectors.plan.canonical_json).manifests as Json[];
  return stored.map((entry) => ({
    key: entry.key,
    org_id: entry.org_id,
    workspace_id: entry.workspace_id,
    source_user_id: entry.source_user_id,
    session: entry.session,
    state: entry.state,
    chunks: entry.chunks,
  }));
}

/** #86 §1 input for the vectors' backfill. */
function backfillInput(overrides: Json = {}): Json {
  const entry = vectors.backfill_entry as Json;
  return {
    v: 2,
    kind: "backfill",
    key: entry.key,
    org_id: entry.org_id,
    workspace_id: entry.workspace_id,
    source_user_id: entry.source_user_id,
    session: entry.session,
    format: "ndjson",
    chunks: entry.chunks.map((chunk: Json) => ({ ...chunk })),
    ...overrides,
  };
}

function derive(plan: unknown) {
  return deriveMigrationGrantPlan({ grantId: GRANT_ID, orgId: ORG, plan });
}

function v2Plan(backfills: Json[] = [backfillInput()]) {
  return {
    exported_at: vectors.exported_at,
    manifests: v1ManifestInputs(),
    backfills,
  };
}

function expectInvalid(plan: unknown, message?: RegExp) {
  assert.throws(
    () => derive(plan),
    (error: unknown) =>
      error instanceof MigrationPlanError &&
      error.code === "invalid_plan" &&
      (!message || message.test(error.message)),
  );
}

test("v2 prototype: absent and empty backfills give the byte-identical v1 plan", () => {
  const absent = derive({ exported_at: vectors.exported_at, manifests: v1ManifestInputs() });
  const empty = derive({ ...v2Plan([]) });
  for (const derived of [absent, empty]) {
    assert.equal(derived.planDigest, V1_DIGEST);
    assert.equal(derived.plan.v, 1);
    assert.equal("backfills" in derived.plan, false);
  }
  assert.equal(
    canonicalMigrationJson(empty.plan),
    canonicalMigrationJson(absent.plan),
  );
  assert.deepEqual(empty.allowedPairs, absent.allowedPairs);
  assert.equal(empty.allowedPairHash, absent.allowedPairHash);
  // Stored v1 plans keep verifying.
  verifyStoredMigrationGrantPlan({
    grantId: GRANT_ID,
    orgId: ORG,
    planDigest: absent.planDigest,
    allowedPairs: absent.allowedPairs,
    plan: absent.plan,
  });
});

test("v2 prototype: reproduces the #79 entry, digests and plan", () => {
  const derived = derive(v2Plan());
  assert.equal(derived.plan.v, 2);
  const plan = derived.plan as Extract<MigrationGrantPlan, { v: 2 }>;
  assert.equal(plan.backfills.length, 1);
  const entry = plan.backfills[0]!;
  assert.deepEqual(entry, vectors.backfill_entry);
  assert.equal(canonicalMigrationJson(entry), vectors.backfill_entry_canonical_json);
  assert.equal(migrationSha256(canonicalMigrationJson(entry)), vectors.backfill_entry_sha256);
  assert.equal(entry.backfill_sha256, vectors.backfill_entry.backfill_sha256);
  assert.equal(canonicalMigrationJson(plan), vectors.plan.canonical_json);
  assert.equal(derived.planDigest, vectors.plan.plan_digest);
  // v1 entries are carried byte for byte.
  assert.equal(
    canonicalMigrationJson(plan.manifests),
    canonicalMigrationJson(derive({ exported_at: vectors.exported_at, manifests: v1ManifestInputs() }).plan.manifests),
  );
  verifyStoredMigrationGrantPlan({
    grantId: GRANT_ID,
    orgId: ORG,
    planDigest: derived.planDigest,
    allowedPairs: derived.allowedPairs,
    plan: derived.plan,
  });
});

test("v2 prototype: signed identities reproduce #79 and carry only stored fields", () => {
  const plan = derive(v2Plan()).plan as Extract<MigrationGrantPlan, { v: 2 }>;
  const entry = plan.backfills[0]!;
  const base = normalizeMigrationBackfillBase(vectors.base);
  const commit = migrationBackfillUploadIdentity(entry, vectors.plan.plan_digest, base);
  assert.deepEqual(commit, vectors.upload_identity);
  assert.equal(
    `${commit.key}@${commit.entry_sha256}@r${commit.base.revision + 1}`,
    vectors.work_key,
  );
  const read = migrationBackfillBaseReadIdentity(entry, vectors.plan.plan_digest);
  const { backfill_sha256: _b, base: _base, kind: _k, ...shared } = vectors.upload_identity;
  assert.deepEqual(read, { ...shared, kind: "backfill_base_read" });
  assert.deepEqual(Object.keys(read).sort(), [
    "entry_sha256", "grant_id", "key", "kind", "org_id", "plan_digest",
    "session", "source_user_id", "v", "workspace_id",
  ]);
});

test("v2 prototype: #86 §8 negative plan cases are invalid_plan", async (t) => {
  const chunks = (vectors.backfill_entry.chunks as Json[]).map((chunk) => ({ ...chunk }));
  const cases: Array<[string, Json[]]> = [
    ["missing records", [backfillInput({ chunks: [{ ...chunks[0], records: undefined }, chunks[1]].map((c) => JSON.parse(JSON.stringify(c))) })]],
    ["non-contiguous offsets", [backfillInput({ chunks: [chunks[0], { ...chunks[1], start_offset: 2049 }] })]],
    ["first offset not 0", [backfillInput({ chunks: [{ ...chunks[0], start_offset: 1 }] })]],
    ["supplied backfill_sha256", [backfillInput({ backfill_sha256: vectors.backfill_entry.backfill_sha256 })]],
    ["supplied raw_bytes", [backfillInput({ raw_bytes: 2825 })]],
    ["supplied grant_id", [backfillInput({ grant_id: GRANT_ID })]],
    ["duplicate backfill key", [backfillInput(), backfillInput()]],
    ["wrong format", [backfillInput({ format: "jsonl" })]],
    ["wrong version", [backfillInput({ v: 1 })]],
    ["wrong kind", [backfillInput({ kind: "manifest" })]],
    ["other org", [backfillInput({ org_id: "org_other" })]],
    ["key does not match session", [backfillInput({ session: { ...vectors.backfill_entry.session, session_id: "session-other" } })]],
    ["zero bytes", [backfillInput({ chunks: [{ ...chunks[0], bytes: 0 }] })]],
    ["chunk has seq", [backfillInput({ chunks: [{ ...chunks[0], seq: 0 }] })]],
    ["chunk has epoch", [backfillInput({ chunks: [{ ...chunks[0], epoch: 0 }] })]],
    ["uppercase sha256", [backfillInput({ chunks: [{ ...chunks[0], sha256: chunks[0]!.sha256.toUpperCase() }] })]],
    ["negative records", [backfillInput({ chunks: [{ ...chunks[0], records: -1 }] })]],
    ["fractional bytes", [backfillInput({ chunks: [{ ...chunks[0], bytes: 1.5 }] })]],
    ["unsafe offset", [backfillInput({ chunks: [{ ...chunks[0], bytes: Number.MAX_SAFE_INTEGER }, { ...chunks[1], start_offset: Number.MAX_SAFE_INTEGER }] })]],
    ["no chunks", [backfillInput({ chunks: [] })]],
    ["too many chunks", [backfillInput({ chunks: Array.from({ length: MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY + 1 }, (_, i) => ({ start_offset: i, bytes: 1, sha256: "a".repeat(64), records: 0 })) })]],
    ["relay_ alias key mismatch", [backfillInput({ workspace_id: "relay_ws_other" })]],
  ];
  for (const [name, backfills] of cases) {
    await t.test(name, () => expectInvalid(v2Plan(backfills)));
  }
  await t.test("key in both manifests and backfills", () => {
    const manifest = v1ManifestInputs()[0]!;
    expectInvalid(
      v2Plan([
        backfillInput({
          key: manifest.key,
          session: manifest.session,
          workspace_id: manifest.workspace_id,
        }),
      ]),
      /across manifests and backfills/u,
    );
  });
  await t.test("backfills is not an array", () => expectInvalid({ ...v2Plan(), backfills: {} }));
  await t.test("combined entry cap", () =>
    expectInvalid({
      ...v2Plan(),
      backfills: Array.from({ length: MAX_MIGRATION_GRANT_ENTRIES - 1 }, () => backfillInput()),
    }),
  );
});

test("v2 prototype: stored-plan verification recomputes every v2 field", async (t) => {
  const derived = derive(v2Plan());
  const verify = (plan: unknown, planDigest = derived.planDigest) =>
    verifyStoredMigrationGrantPlan({
      grantId: GRANT_ID,
      orgId: ORG,
      planDigest,
      allowedPairs: derived.allowedPairs,
      plan: plan as MigrationGrantPlan,
    });
  const tamper = (mutate: (plan: Json) => void) => {
    const copy = structuredClone(derived.plan) as Json;
    mutate(copy);
    return copy;
  };
  const cases: Array<[string, Json]> = [
    ["backfill chunk digest", tamper((p) => { p.backfills[0].chunks[0].sha256 = "f".repeat(64); })],
    ["backfill_sha256", tamper((p) => { p.backfills[0].backfill_sha256 = "0".repeat(64); })],
    ["raw_bytes", tamper((p) => { p.backfills[0].raw_bytes += 1; })],
    ["backfill grant_id", tamper((p) => { p.backfills[0].grant_id = "mgr_11111111111111111111111111111111"; })],
    ["v2 with no backfills", tamper((p) => { p.backfills = []; })],
    ["v2 without backfills", tamper((p) => { delete p.backfills; })],
    ["v1 carrying backfills", tamper((p) => { p.v = 1; })],
    ["v3", tamper((p) => { p.v = 3; })],
  ];
  for (const [name, plan] of cases) {
    await t.test(name, () => assert.throws(() => verify(plan), MigrationPlanError));
  }
  await t.test("v1 digest on a v2 plan", () =>
    assert.throws(() => verify(derived.plan, V1_DIGEST), MigrationPlanError),
  );
});

test("v2 prototype: base shape and exact safe-integer bounds", async (t) => {
  const base = vectors.base as Json;
  assert.deepEqual(normalizeMigrationBackfillBase(base), base);
  assert.deepEqual(
    normalizeMigrationBackfillBase({
      ...base,
      revision: Number.MAX_SAFE_INTEGER - 1,
      chunk_count: Number.MAX_SAFE_INTEGER - MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY,
      epoch: 0xffff_fffe,
      version: "v".repeat(512),
    }).revision,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const { writer: _w, ...missing } = base;
  const cases: Array<[string, unknown]> = [
    ["missing key", missing],
    ["extra key", { ...base, format: "ndjson" }],
    ["not an object", [base]],
    ["revision 0", { ...base, revision: 0 }],
    ["revision unsafe", { ...base, revision: Number.MAX_SAFE_INTEGER }],
    ["revision string", { ...base, revision: "7" }],
    ["revision fractional", { ...base, revision: 7.5 }],
    ["chunk_count negative", { ...base, chunk_count: -1 }],
    ["chunk_count over bound", { ...base, chunk_count: Number.MAX_SAFE_INTEGER - MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY + 1 }],
    ["epoch over uint32 - 1", { ...base, epoch: 0xffff_ffff }],
    ["epoch negative", { ...base, epoch: -1 }],
    ["owner migration:", { ...base, owner: "migration:mgr_00000000000000000000000000000000" }],
    ["owner empty", { ...base, owner: "" }],
    ["writer too long", { ...base, writer: "w".repeat(513) }],
    ["version not string", { ...base, version: 7 }],
    ["content_sha256 uppercase", { ...base, content_sha256: String(base.content_sha256).toUpperCase() }],
    ["content_sha256 short", { ...base, content_sha256: "0".repeat(63) }],
  ];
  for (const [name, value] of cases) {
    await t.test(name, () =>
      assert.throws(() => normalizeMigrationBackfillBase(value), MigrationPlanError),
    );
  }
});

test("v2 prototype: identities never take tenancy from anything but the entry", () => {
  const plan = derive(v2Plan()).plan as Extract<MigrationGrantPlan, { v: 2 }>;
  const entry: MigrationBackfillEntry = plan.backfills[0]!;
  const read = migrationBackfillBaseReadIdentity(entry, vectors.plan.plan_digest);
  assert.equal(read.org_id, entry.org_id);
  assert.equal(read.workspace_id, entry.workspace_id);
  assert.equal(read.source_user_id, entry.source_user_id);
  assert.equal(read.grant_id, entry.grant_id);
  assert.equal("base" in read, false);
  assert.equal("backfill_sha256" in read, false);
});
