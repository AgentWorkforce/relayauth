import crypto from "node:crypto";

const RELAY_PREFIX = "relay_";
const ID_SHAPE = /^[A-Za-z0-9._:-]{1,255}$/u;
const KEY_COMPONENT = "[A-Za-z0-9._-]{1,128}";
const MANIFEST_KEY_SHAPE = new RegExp(
  `^v1/ws=(${KEY_COMPONENT})/m=(${KEY_COMPONENT})/h=(${KEY_COMPONENT})/d=(\\d{4})/(\\d{2})/(\\d{2})/s=(${KEY_COMPONENT})/manifest\\.json$`,
  "u",
);
const HEX_64 = /^[0-9a-f]{64}$/u;
const GRANT_ID_SHAPE = /^mgr_[0-9a-f]{32}$/u;

export const MAX_MIGRATION_GRANT_ENTRIES = 1000;
export const MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY = 4096;
export const MAX_MIGRATION_PLAN_TOTAL_CHUNKS = 50_000;
/**
 * D1 caps one string and one table row at 2,000,000 bytes. Keep the two new
 * JSON columns together below 1,000,000 bytes so the legacy user JSON, scalar
 * columns and SQLite row encoding retain ample headroom. The exact contract-v1
 * fixture shared with 96BullSessions #43 is 1,695 bytes combined.
 */
export const MAX_MIGRATION_GRANT_SERIALIZED_BYTES = 1_000_000;
/**
 * Cloud resolves both the canonical and one-prefix alias through an identity
 * Durable Object to detect ambiguity. This cap bounds that work at 128 identity
 * subrequests, leaving headroom under the 1,000 internal-service floor.
 */
export const MAX_MIGRATION_GRANT_SOURCE_USERS = 64;

export type MigrationGrantPair = {
  sourceUserId: string;
  workspaceId: string;
};

export type MigrationPlanChunk = {
  seq: number;
  epoch: number;
  start_offset: number;
  bytes: number;
  sha256: string;
  records: number;
};

export type MigrationPlanSession = {
  machine_id: string;
  harness: string;
  session_id: string;
  started_at: string;
};

export type MigrationPlanEntry = {
  key: string;
  org_id: string;
  workspace_id: string;
  source_user_id: string;
  session: MigrationPlanSession;
  state: "open" | "closed";
  chunks: MigrationPlanChunk[];
  grant_id: string;
  content_sha256: string;
  raw_bytes: number;
};

export type MigrationBackfillChunk = {
  start_offset: number;
  bytes: number;
  sha256: string;
  records: number;
};

/**
 * Plan entry v2 (96BullSessions data contract #79; issuer spec #86, main
 * @ f67f741): one
 * sealed backfill epoch to append to a live ndjson manifest. Chunk positions
 * are relative (offsets from 0, no seq, no epoch); the live base is bound at
 * mint time, not in the plan.
 */
export type MigrationBackfillEntry = {
  v: 2;
  kind: "backfill";
  grant_id: string;
  key: string;
  org_id: string;
  workspace_id: string;
  source_user_id: string;
  session: MigrationPlanSession;
  format: "ndjson";
  chunks: MigrationBackfillChunk[];
  backfill_sha256: string;
  raw_bytes: number;
};

export type MigrationGrantPlanV1 = {
  v: 1;
  grant_id: string;
  exported_at: string;
  manifests: MigrationPlanEntry[];
};

/** Only when there is at least one backfill; otherwise the plan is v1. */
export type MigrationGrantPlanV2 = {
  v: 2;
  grant_id: string;
  exported_at: string;
  manifests: MigrationPlanEntry[];
  backfills: MigrationBackfillEntry[];
};

export type MigrationGrantPlan = MigrationGrantPlanV1 | MigrationGrantPlanV2;

/** The live manifest a backfill appends to, as the courier read it. */
export type MigrationBackfillBase = {
  revision: number;
  version: string;
  owner: string;
  writer: string;
  chunk_count: number;
  epoch: number;
  content_sha256: string;
};

export type MigrationBackfillBaseReadIdentity = {
  v: 2;
  kind: "backfill_base_read";
  grant_id: string;
  plan_digest: string;
  key: string;
  org_id: string;
  workspace_id: string;
  source_user_id: string;
  session: MigrationPlanSession;
  entry_sha256: string;
};

export type MigrationBackfillUploadIdentity = Omit<
  MigrationBackfillBaseReadIdentity,
  "kind"
> & {
  kind: "backfill";
  backfill_sha256: string;
  base: MigrationBackfillBase;
};

export type MigrationUploadIdentity = {
  grant_id: string;
  plan_digest: string;
  key: string;
  org_id: string;
  workspace_id: string;
  source_user_id: string;
  session: MigrationPlanSession;
  content_sha256: string;
  entry_sha256: string;
};

export class MigrationPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /**
     * Precise reason for the internal audit only, when the public `code` and
     * message are deliberately generic.
     */
    readonly auditReason?: string,
  ) {
    super(message);
    this.name = "MigrationPlanError";
  }
}

/** Contract-v1 id form: one optional RelayAuth prefix is stripped. */
export function canonicalMigrationId(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new MigrationPlanError("invalid_plan", `${name} is malformed`);
  }
  const bare = value.startsWith(RELAY_PREFIX)
    ? value.slice(RELAY_PREFIX.length)
    : value;
  if (!ID_SHAPE.test(bare) || bare.startsWith(RELAY_PREFIX)) {
    throw new MigrationPlanError("invalid_plan", `${name} is malformed`);
  }
  return bare;
}

/** JSON with recursively sorted object keys, byte-for-byte with contract v1. */
export function canonicalMigrationJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMigrationJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalMigrationJson(record[key])}`,
      )
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new MigrationPlanError("invalid_plan", "plan contains undefined");
  }
  return encoded;
}

export function migrationSha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Manifest-v1 content hash chain over the source chunk identity. */
export function migrationContentSha256(
  chunks: readonly Pick<
    MigrationPlanChunk,
    "epoch" | "start_offset" | "bytes" | "sha256"
  >[],
): string {
  let hash = Buffer.alloc(32);
  for (const chunk of chunks) {
    const buffer = Buffer.alloc(32 + 4 + 8 + 8 + 32);
    hash.copy(buffer, 0);
    buffer.writeUInt32BE(chunk.epoch, 32);
    buffer.writeBigUInt64BE(BigInt(chunk.start_offset), 36);
    buffer.writeBigUInt64BE(BigInt(chunk.bytes), 44);
    Buffer.from(chunk.sha256, "hex").copy(buffer, 52);
    hash = crypto.createHash("sha256").update(buffer).digest();
  }
  return hash.toString("hex");
}

export function deriveMigrationGrantPlan(input: {
  grantId: string;
  orgId: string;
  plan: unknown;
}): {
  plan: MigrationGrantPlan;
  planDigest: string;
  allowedPairs: MigrationGrantPair[];
  allowedPairHash: string;
} {
  if (!GRANT_ID_SHAPE.test(input.grantId)) {
    throw new MigrationPlanError("invalid_plan", "grant id is malformed");
  }
  const orgId = canonicalMigrationId(input.orgId, "organization id");
  const rawPlan = objectWithAllowedKeys(
    input.plan,
    ["exported_at", "manifests", "backfills"],
    ["exported_at", "manifests"],
    "plan",
  );
  const exportedAt = canonicalTimestamp(rawPlan.exported_at, "exported_at");
  // #86 §1 legacy conditional. Absent `backfills` or `backfills: []` is the
  // v1 path, byte for byte (including v1's 1..1000 manifests rule). A
  // non-empty array is v2, where `manifests` may be empty. Anything else
  // (null, an object, a string) is refused.
  if (rawPlan.backfills !== undefined && !Array.isArray(rawPlan.backfills)) {
    throw new MigrationPlanError(
      "invalid_plan",
      "plan.backfills must be an array",
    );
  }
  const rawBackfills: unknown[] = Array.isArray(rawPlan.backfills)
    ? rawPlan.backfills
    : [];
  const minManifests = rawBackfills.length === 0 ? 1 : 0;
  if (
    !Array.isArray(rawPlan.manifests) ||
    rawPlan.manifests.length < minManifests ||
    rawPlan.manifests.length > MAX_MIGRATION_GRANT_ENTRIES
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `plan.manifests must contain ${minManifests} to ${MAX_MIGRATION_GRANT_ENTRIES} entries`,
    );
  }
  if (rawBackfills.length > MAX_MIGRATION_GRANT_ENTRIES) {
    throw new MigrationPlanError(
      "invalid_plan",
      `plan.backfills must contain at most ${MAX_MIGRATION_GRANT_ENTRIES} entries`,
    );
  }
  if (
    rawPlan.manifests.length + rawBackfills.length >
    MAX_MIGRATION_GRANT_ENTRIES
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `plan.manifests and plan.backfills together must contain at most ${MAX_MIGRATION_GRANT_ENTRIES} entries`,
    );
  }

  let totalChunks = 0;
  for (const rawEntry of [...rawPlan.manifests, ...rawBackfills]) {
    if (rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)) {
      const rawChunks = (rawEntry as Record<string, unknown>).chunks;
      if (Array.isArray(rawChunks)) {
        totalChunks += rawChunks.length;
      }
    }
    if (totalChunks > MAX_MIGRATION_PLAN_TOTAL_CHUNKS) {
      throw new MigrationPlanError(
        "invalid_plan",
        `plan contains more than ${MAX_MIGRATION_PLAN_TOTAL_CHUNKS} chunks`,
      );
    }
  }

  const manifests = rawPlan.manifests.map((value, index) =>
    normalizePlanEntry(value, index, input.grantId, orgId),
  );
  manifests.sort(compareByKey);
  const backfills = rawBackfills.map((value, index) =>
    normalizeBackfillEntry(value, index, input.grantId, orgId),
  );
  backfills.sort(compareByKey);
  const allKeys = [...manifests, ...backfills].map((entry) => entry.key);
  if (new Set(allKeys).size !== allKeys.length) {
    throw new MigrationPlanError(
      "invalid_plan",
      "plan lists a manifest key more than once across manifests and backfills",
    );
  }

  const plan: MigrationGrantPlan =
    backfills.length === 0
      ? { v: 1, grant_id: input.grantId, exported_at: exportedAt, manifests }
      : {
          v: 2,
          grant_id: input.grantId,
          exported_at: exportedAt,
          manifests,
          backfills,
        };
  const planDigest = migrationSha256(canonicalMigrationJson(plan));
  const allowedPairs = normalizeMigrationGrantPairs(
    [...manifests, ...backfills].map((entry) => ({
      sourceUserId: entry.source_user_id,
      workspaceId: entry.workspace_id,
    })),
  );
  const sourceUserCount = new Set(
    allowedPairs.map((pair) => pair.sourceUserId),
  ).size;
  if (sourceUserCount > MAX_MIGRATION_GRANT_SOURCE_USERS) {
    throw new MigrationPlanError(
      "migration_plan_source_user_limit",
      `plan contains more than ${MAX_MIGRATION_GRANT_SOURCE_USERS} distinct source users`,
    );
  }
  if (
    migrationGrantSerializedBytes(plan, allowedPairs) >
    MAX_MIGRATION_GRANT_SERIALIZED_BYTES
  ) {
    throw new MigrationPlanError(
      "migration_plan_too_large",
      `canonical plan and allowed pairs exceed ${MAX_MIGRATION_GRANT_SERIALIZED_BYTES} bytes`,
    );
  }
  return {
    plan,
    planDigest,
    allowedPairs,
    allowedPairHash: migrationAllowedPairHash(allowedPairs),
  };
}

/** Recompute every derived field before trusting a persisted plan. */
export function verifyStoredMigrationGrantPlan(input: {
  grantId: string;
  orgId: string;
  planDigest: string;
  allowedPairs: readonly MigrationGrantPair[];
  plan: MigrationGrantPlan;
}): void {
  const stored = input.plan;
  if (
    !stored ||
    (stored.v !== 1 && stored.v !== 2) ||
    stored.grant_id !== input.grantId ||
    !Array.isArray(stored.manifests) ||
    (stored.v === 2 && !Array.isArray(stored.backfills))
  ) {
    throw new MigrationPlanError("invalid_plan", "stored plan is malformed");
  }
  // Rebuild the client request from the stored plan and re-derive it, so every
  // derived field (grant ids, content and backfill digests, raw bytes, the
  // plan version) is recomputed rather than trusted. A stored v2 plan with no
  // backfills re-derives as v1 and therefore fails the comparison below.
  const derived = deriveMigrationGrantPlan({
    grantId: input.grantId,
    orgId: input.orgId,
    plan: {
      exported_at: stored.exported_at,
      manifests: stored.manifests.map((entry) => ({
        key: entry.key,
        org_id: entry.org_id,
        workspace_id: entry.workspace_id,
        source_user_id: entry.source_user_id,
        session: entry.session,
        state: entry.state,
        chunks: entry.chunks,
      })),
      ...(stored.v === 2
        ? {
            backfills: stored.backfills.map((entry) => ({
              v: entry.v,
              kind: entry.kind,
              key: entry.key,
              org_id: entry.org_id,
              workspace_id: entry.workspace_id,
              source_user_id: entry.source_user_id,
              session: entry.session,
              format: entry.format,
              chunks: entry.chunks,
            })),
          }
        : {}),
    },
  });
  if (
    derived.planDigest !== input.planDigest ||
    canonicalMigrationJson(derived.plan) !== canonicalMigrationJson(stored) ||
    canonicalMigrationJson(derived.allowedPairs) !==
      canonicalMigrationJson(normalizeMigrationGrantPairs(input.allowedPairs))
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      "stored plan, digest and allowed pairs disagree",
    );
  }
}

export function migrationAllowedPairHash(
  pairs: readonly MigrationGrantPair[],
): string {
  const canonicalPairs = normalizeMigrationGrantPairs(pairs).map((pair) => ({
    source_user_id: pair.sourceUserId,
    workspace_id: pair.workspaceId,
  }));
  return migrationSha256(canonicalMigrationJson(canonicalPairs));
}

export function migrationUploadIdentity(
  entry: MigrationPlanEntry,
  planDigest: string,
): MigrationUploadIdentity {
  return {
    grant_id: entry.grant_id,
    plan_digest: planDigest,
    key: entry.key,
    org_id: entry.org_id,
    workspace_id: entry.workspace_id,
    source_user_id: entry.source_user_id,
    session: { ...entry.session },
    content_sha256: entry.content_sha256,
    entry_sha256: migrationSha256(canonicalMigrationJson(entry)),
  };
}

/**
 * The signed v2 base-read capability (#86 §4): binds one org, source user,
 * workspace, manifest key and session, one grant and one plan. Every field
 * comes from the stored entry and the grant.
 */
export function migrationBackfillBaseReadIdentity(
  entry: MigrationBackfillEntry,
  planDigest: string,
): MigrationBackfillBaseReadIdentity {
  return {
    v: 2,
    kind: "backfill_base_read",
    grant_id: entry.grant_id,
    plan_digest: planDigest,
    key: entry.key,
    org_id: entry.org_id,
    workspace_id: entry.workspace_id,
    source_user_id: entry.source_user_id,
    session: { ...entry.session },
    entry_sha256: migrationSha256(canonicalMigrationJson(entry)),
  };
}

/**
 * The signed v2 commit identity (#86 §5). Every field except `base` comes
 * from the stored entry; `base` is the request's, shape-checked only.
 */
export function migrationBackfillUploadIdentity(
  entry: MigrationBackfillEntry,
  planDigest: string,
  base: MigrationBackfillBase,
): MigrationBackfillUploadIdentity {
  return {
    ...migrationBackfillBaseReadIdentity(entry, planDigest),
    kind: "backfill",
    backfill_sha256: entry.backfill_sha256,
    base: { ...base },
  };
}

const MAX_BACKFILL_BASE_STRING_LENGTH = 512;
/**
 * The appended chunks take seq = chunk_count + i, with i below the per-entry
 * chunk cap, so the highest seq stays a safe integer.
 */
const MAX_MIGRATION_BACKFILL_BASE_CHUNK_COUNT =
  Number.MAX_SAFE_INTEGER - MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY;
const MIGRATION_OWNER_PREFIX = "migration:";

/**
 * Shape-only check of a mint request's `base` (#86 §5). The issuer cannot
 * vouch for it; the ingest compares it with storage at commit.
 */
export function normalizeMigrationBackfillBase(
  value: unknown,
): MigrationBackfillBase {
  const raw = objectWithExactKeys(
    value,
    [
      "revision",
      "version",
      "owner",
      "writer",
      "chunk_count",
      "epoch",
      "content_sha256",
    ],
    "upload.base",
  );
  // #86 §5 bounds: the commit writes revision + 1, chunk_count + i and
  // epoch + 1, so each must stay representable (a safe integer; a manifest
  // chunk epoch is a uint32).
  const revision = uint(
    raw.revision,
    "upload.base.revision",
    Number.MAX_SAFE_INTEGER - 1,
  );
  if (revision < 1) {
    throw new MigrationPlanError(
      "invalid_plan",
      "upload.base.revision must be at least 1",
    );
  }
  const text = (field: string): string => {
    const candidate = raw[field];
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > MAX_BACKFILL_BASE_STRING_LENGTH
    ) {
      throw new MigrationPlanError(
        "invalid_plan",
        `upload.base.${field} must be a non-empty string of at most ${MAX_BACKFILL_BASE_STRING_LENGTH} characters`,
      );
    }
    return candidate;
  };
  const owner = text("owner");
  if (owner.startsWith(MIGRATION_OWNER_PREFIX)) {
    throw new MigrationPlanError(
      "invalid_plan",
      "upload.base.owner must be the live owner, not a migration owner",
    );
  }
  if (typeof raw.content_sha256 !== "string" || !HEX_64.test(raw.content_sha256)) {
    throw new MigrationPlanError(
      "invalid_plan",
      "upload.base.content_sha256 is malformed",
    );
  }
  return {
    revision,
    version: text("version"),
    owner,
    writer: text("writer"),
    chunk_count: uint(
      raw.chunk_count,
      "upload.base.chunk_count",
      MAX_MIGRATION_BACKFILL_BASE_CHUNK_COUNT,
    ),
    epoch: uint(raw.epoch, "upload.base.epoch", 0xffff_fffe),
    content_sha256: raw.content_sha256,
  };
}

function compareByKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Key, workspace and session checks shared by v1 and v2 entries. */
function normalizeEntryLocation(
  raw: Record<string, unknown>,
  name: string,
): {
  key: string;
  workspaceId: string;
  sourceUserId: string;
  session: MigrationPlanSession;
} {
  const workspaceId = canonicalMigrationId(
    raw.workspace_id,
    `${name}.workspace_id`,
  );
  const sourceUserId = canonicalMigrationId(
    raw.source_user_id,
    `${name}.source_user_id`,
  );
  const sessionRaw = objectWithExactKeys(
    raw.session,
    ["machine_id", "harness", "session_id", "started_at"],
    `${name}.session`,
  );
  const session: MigrationPlanSession = {
    machine_id: keyComponent(sessionRaw.machine_id, `${name}.session.machine_id`),
    harness: keyComponent(sessionRaw.harness, `${name}.session.harness`),
    session_id: keyComponent(sessionRaw.session_id, `${name}.session.session_id`),
    started_at: canonicalTimestamp(
      sessionRaw.started_at,
      `${name}.session.started_at`,
    ),
  };
  if (typeof raw.key !== "string") {
    throw new MigrationPlanError("invalid_plan", `${name}.key is malformed`);
  }
  const key = raw.key;
  const keyMatch = MANIFEST_KEY_SHAPE.exec(key);
  if (!keyMatch) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name}.key is not a canonical v1 manifest key`,
    );
  }
  const [, keyWorkspace, machine, harness, year, month, day, sessionId] =
    keyMatch;
  const startedDate = new Date(session.started_at).toISOString().slice(0, 10);
  if (
    keyWorkspace !== workspaceId ||
    machine !== session.machine_id ||
    harness !== session.harness ||
    sessionId !== session.session_id ||
    `${year}-${month}-${day}` !== startedDate
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name}.key does not match its workspace and session`,
    );
  }
  return { key, workspaceId, sourceUserId, session };
}

function normalizeBackfillEntry(
  value: unknown,
  index: number,
  grantId: string,
  orgId: string,
): MigrationBackfillEntry {
  const name = `plan.backfills[${index}]`;
  // Exactly the #86 §1 input keys: a client-supplied grant_id,
  // backfill_sha256 or raw_bytes is refused, never trusted.
  const raw = objectWithExactKeys(
    value,
    [
      "v",
      "kind",
      "key",
      "org_id",
      "workspace_id",
      "source_user_id",
      "session",
      "format",
      "chunks",
    ],
    name,
  );
  if (raw.v !== 2 || raw.kind !== "backfill") {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name} must be a v2 backfill entry`,
    );
  }
  // Ruling on #86: a wrong-org v2 entry is a generic invalid_plan to the
  // caller (it does not confirm which org is wrong); the precise reason
  // reaches only the internal audit row. v1 keeps plan_org_mismatch.
  if (canonicalMigrationId(raw.org_id, `${name}.org_id`) !== orgId) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name} is invalid`,
      "backfill_org_mismatch",
    );
  }
  const location = normalizeEntryLocation(raw, name);
  if (raw.format !== "ndjson") {
    throw new MigrationPlanError("invalid_plan", `${name}.format must be ndjson`);
  }
  if (
    !Array.isArray(raw.chunks) ||
    raw.chunks.length === 0 ||
    raw.chunks.length > MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name}.chunks must contain 1 to ${MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY} chunks`,
    );
  }
  let offset = 0;
  const chunks = raw.chunks.map((chunk, chunkIndex): MigrationBackfillChunk => {
    const chunkName = `${name}.chunks[${chunkIndex}]`;
    const rawChunk = objectWithExactKeys(
      chunk,
      ["start_offset", "bytes", "sha256", "records"],
      chunkName,
    );
    const startOffset = uint(rawChunk.start_offset, `${chunkName}.start_offset`);
    if (startOffset !== offset) {
      throw new MigrationPlanError(
        "invalid_plan",
        `${chunkName}.start_offset must be ${offset}`,
      );
    }
    const bytes = uint(rawChunk.bytes, `${chunkName}.bytes`);
    if (bytes === 0) {
      throw new MigrationPlanError("invalid_plan", `${chunkName}.bytes must be positive`);
    }
    // #86 §2: start_offset + bytes <= MAX, checked exactly (no float sum).
    if (bytes > Number.MAX_SAFE_INTEGER - startOffset) {
      throw new MigrationPlanError("invalid_plan", `${name}.raw_bytes overflows`);
    }
    if (typeof rawChunk.sha256 !== "string" || !HEX_64.test(rawChunk.sha256)) {
      throw new MigrationPlanError("invalid_plan", `${chunkName}.sha256 is malformed`);
    }
    const records = uint(rawChunk.records, `${chunkName}.records`);
    offset += bytes;
    return { start_offset: startOffset, bytes, sha256: rawChunk.sha256, records };
  });
  return {
    v: 2,
    kind: "backfill",
    grant_id: grantId,
    key: location.key,
    org_id: orgId,
    workspace_id: location.workspaceId,
    source_user_id: location.sourceUserId,
    session: location.session,
    format: "ndjson",
    chunks,
    // #46 backfillDigest: the manifest v1 hash chain with every epoch 0.
    backfill_sha256: migrationContentSha256(
      chunks.map((chunk) => ({ ...chunk, epoch: 0 })),
    ),
    raw_bytes: offset,
  };
}

function normalizePlanEntry(
  value: unknown,
  index: number,
  grantId: string,
  orgId: string,
): MigrationPlanEntry {
  const name = `plan.manifests[${index}]`;
  const raw = objectWithExactKeys(
    value,
    [
      "key",
      "org_id",
      "workspace_id",
      "source_user_id",
      "session",
      "state",
      "chunks",
    ],
    name,
  );
  const entryOrg = canonicalMigrationId(raw.org_id, `${name}.org_id`);
  if (entryOrg !== orgId) {
    throw new MigrationPlanError(
      "plan_org_mismatch",
      `${name}.org_id is outside the caller's organization`,
    );
  }
  if (raw.state !== "open" && raw.state !== "closed") {
    throw new MigrationPlanError("invalid_plan", `${name}.state is malformed`);
  }
  const {
    key,
    workspaceId,
    sourceUserId,
    session,
  } = normalizeEntryLocation(raw, name);
  if (
    !Array.isArray(raw.chunks) ||
    raw.chunks.length === 0 ||
    raw.chunks.length > MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name}.chunks must contain 1 to ${MAX_MIGRATION_PLAN_CHUNKS_PER_ENTRY} chunks`,
    );
  }
  const chunks = raw.chunks.map((chunk, chunkIndex) =>
    normalizeChunk(chunk, name, chunkIndex),
  );
  return {
    key,
    org_id: entryOrg,
    workspace_id: workspaceId,
    source_user_id: sourceUserId,
    session,
    state: raw.state,
    chunks,
    grant_id: grantId,
    content_sha256: migrationContentSha256(chunks),
    raw_bytes: chunks.reduce((sum, chunk) => {
      const next = sum + chunk.bytes;
      if (!Number.isSafeInteger(next)) {
        throw new MigrationPlanError("invalid_plan", `${name}.raw_bytes overflows`);
      }
      return next;
    }, 0),
  };
}

function normalizeChunk(
  value: unknown,
  entryName: string,
  index: number,
): MigrationPlanChunk {
  const name = `${entryName}.chunks[${index}]`;
  const raw = objectWithAllowedKeys(
    value,
    ["seq", "epoch", "start_offset", "bytes", "sha256", "records"],
    ["seq", "epoch", "start_offset", "bytes", "sha256"],
    name,
  );
  const seq = uint(raw.seq, `${name}.seq`);
  if (seq !== index) {
    throw new MigrationPlanError("invalid_plan", `${name}.seq must be ${index}`);
  }
  const epoch = uint(raw.epoch, `${name}.epoch`, 0xffff_ffff);
  const startOffset = uint(raw.start_offset, `${name}.start_offset`);
  const bytes = uint(raw.bytes, `${name}.bytes`);
  if (bytes === 0) {
    throw new MigrationPlanError("invalid_plan", `${name}.bytes must be positive`);
  }
  if (typeof raw.sha256 !== "string" || !HEX_64.test(raw.sha256)) {
    throw new MigrationPlanError("invalid_plan", `${name}.sha256 is malformed`);
  }
  const records =
    raw.records === undefined ? 0 : uint(raw.records, `${name}.records`);
  return {
    seq,
    epoch,
    start_offset: startOffset,
    bytes,
    sha256: raw.sha256,
    records,
  };
}

/**
 * Normalize the storage boundary shared by Node SQLite and external adapters.
 * Objects must contain exactly the two contract fields; identities are
 * canonicalized, then pairs are sorted and de-duplicated deterministically.
 */
export function normalizeMigrationGrantPairs(
  value: unknown,
): MigrationGrantPair[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MIGRATION_GRANT_ENTRIES
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `allowed pairs must contain 1 to ${MAX_MIGRATION_GRANT_ENTRIES} entries`,
    );
  }
  return sortedUniquePairs(
    value.map((pair) => {
      const record = objectWithExactKeys(
        pair,
        ["sourceUserId", "workspaceId"],
        "allowed pair",
      );
      return {
        sourceUserId: canonicalMigrationId(
          record.sourceUserId,
          "source user id",
        ),
        workspaceId: canonicalMigrationId(
          record.workspaceId,
          "workspace id",
        ),
      };
    }),
  );
}

/** Exact UTF-8 bytes persisted across allowed_pairs_json and plan_json. */
export function migrationGrantSerializedBytes(
  plan: MigrationGrantPlan,
  allowedPairs: readonly MigrationGrantPair[],
): number {
  return (
    Buffer.byteLength(canonicalMigrationJson(plan), "utf8") +
    Buffer.byteLength(
      canonicalMigrationJson(normalizeMigrationGrantPairs(allowedPairs)),
      "utf8",
    )
  );
}

function sortedUniquePairs(
  pairs: readonly MigrationGrantPair[],
): MigrationGrantPair[] {
  const normalized = pairs.map((pair) => ({
    sourceUserId: canonicalMigrationId(pair.sourceUserId, "source user id"),
    workspaceId: canonicalMigrationId(pair.workspaceId, "workspace id"),
  }));
  normalized.sort((a, b) => {
    const ak = `${a.sourceUserId}\u0000${a.workspaceId}`;
    const bk = `${b.sourceUserId}\u0000${b.workspaceId}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return normalized.filter(
    (pair, index) =>
      index === 0 ||
      pair.sourceUserId !== normalized[index - 1]!.sourceUserId ||
      pair.workspaceId !== normalized[index - 1]!.workspaceId,
  );
}

function objectWithExactKeys(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  return objectWithAllowedKeys(value, keys, keys, name);
}

function objectWithAllowedKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationPlanError("invalid_plan", `${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const present = Object.keys(record).sort();
  if (
    present.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name} has missing or unsupported fields`,
    );
  }
  return record;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new MigrationPlanError("invalid_plan", `${name} is malformed`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new MigrationPlanError(
      "invalid_plan",
      `${name} must be canonical ISO 8601 UTC`,
    );
  }
  return value;
}

function keyComponent(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${KEY_COMPONENT}$`, "u").test(value) ||
    value.startsWith(".")
  ) {
    throw new MigrationPlanError("invalid_plan", `${name} is malformed`);
  }
  return value;
}

function uint(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new MigrationPlanError("invalid_plan", `${name} is malformed`);
  }
  return value;
}
