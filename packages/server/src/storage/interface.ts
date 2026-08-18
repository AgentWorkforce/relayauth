import type {
  AgentIdentity,
  AuditAction,
  AuditEntry,
  IdentityStatus,
  IdentityType,
  Policy,
  PolicyCondition,
  PolicyEffect,
  Role,
} from "@relayauth/types";
import type {
  IdentityBudget,
  IdentityBudgetUsage,
  StoredIdentity,
} from "./identity-types.js";
import type {
  CreateApiKeyInput,
  ListApiKeysOptions,
  StoredApiKey,
} from "./api-key-types.js";

export type ExtendedAuditAction =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

export type AuditLogWriteEntry = Omit<AuditEntry, "action"> & {
  action: ExtendedAuditAction;
};

export type AuditEntryRecord = AuditEntry & {
  createdAt?: string;
};

export type ListIdentitiesOptions = {
  status?: IdentityStatus;
  type?: IdentityType;
  limit?: number;
  cursorId?: string;
};

export type IdentityChildSummary = {
  id: string;
  name: string;
  status: StoredIdentity["status"];
  sponsorId?: string;
  createdAt?: string;
};

export type IdentityStatusCounts = {
  activeIdentities: number;
  suspendedIdentities: number;
};

export type RoleUpdate = Partial<Pick<Role, "name" | "description" | "scopes">>;

export type PolicyUpdate = Partial<
  Pick<Policy, "name" | "effect" | "scopes" | "conditions" | "priority">
>;

export type AuditEntryCursor = {
  /** Existing entry-position cursor. `kind` is omitted by legacy callers. */
  kind?: "entry";
  timestamp: string;
  id: string;
};

/**
 * A durable scan boundary between immutable archive partitions. It is not an
 * audit entry id: resuming starts strictly before this minute.
 */
export type AuditArchivePartitionCursor = {
  kind: "archive_partition";
  orgId: string;
  timestamp: string;
  /**
   * Resume at (rather than strictly before) this partition. This is used only
   * when a fixed budget is exhausted before any chunk of the partition is
   * read, so the next request cannot skip that unread partition.
   */
  inclusive?: boolean;
  /**
   * The next unread immutable index chunk for a partition that is larger than
   * one request's fixed R2 budget. It is a resumable position, never an
   * emitted chunk, so a continuation cannot duplicate prior entries.
   */
  chunk?: {
    key: string;
    sha256: string;
  };
  /** Original entry page boundary, retained when budget continuation starts mid-page. */
  entryCursor?: AuditEntryCursor;
  /**
   * Opaque canonical query scope. Archive cursors may only be replayed by the
   * exact org-scoped query that produced them; this prevents a continuation
   * from being reused with broader/narrower filters or a different ordering.
   */
  filterKey: string;
};

export type AuditQueryCursor = AuditEntryCursor | AuditArchivePartitionCursor;

export type AuditQueryWorkBudget = {
  hotStorePages: number;
  hotStoreRows: number;
  archivePartitions: number;
  archiveReads: number;
};

export type AuditQueryInput = {
  orgId: string;
  identityId?: string;
  action?: AuditAction;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  cursor?: AuditQueryCursor;
  limit: number;
};

export type AuditQueryOptions = {
  includeOverflowRow?: boolean;
};

export type AuditQueryResult =
  | {
      kind: "complete";
      entries: AuditEntryRecord[];
    }
  | {
      kind: "budget_exhausted";
      entries: AuditEntryRecord[];
      continuation: AuditArchivePartitionCursor;
      workBudget: AuditQueryWorkBudget;
    };

export type DashboardAuditQuery = {
  from?: string;
  to?: string;
  cursor?: AuditArchivePartitionCursor;
};

/**
 * The archive is ordered timestamp DESC, id DESC. Keep this canonical key in
 * the storage contract so every backend produces continuations accepted by
 * the HTTP boundary without copying filter semantics. Pagination position is
 * carried by the continuation cursor itself and is deliberately not query
 * scope: it changes between otherwise identical page requests.
 */
export function createAuditQueryContinuationFilterKey(
  query: Pick<
    AuditQueryInput,
    | "identityId"
    | "action"
    | "workspaceId"
    | "plane"
    | "result"
    | "from"
    | "to"
    | "limit"
  >,
): string {
  const from = normalizeAuditQueryTimestamp(query.from, "from");
  const to = normalizeAuditQueryTimestamp(query.to, "to");
  return JSON.stringify({
    version: 1,
    resource: "audit",
    order: "timestamp_desc_id_desc",
    identityId: query.identityId ?? null,
    action: query.action ?? null,
    workspaceId: query.workspaceId ?? null,
    plane: query.plane ?? null,
    result: query.result ?? null,
    from: from ?? null,
    to: to ?? null,
    limit: query.limit,
  });
}

/** Dashboard supports only the documented exact from/to range tuple. */
export function createDashboardAuditContinuationFilterKey(
  query: Pick<DashboardAuditQuery, "from" | "to">,
): string {
  const from = normalizeAuditQueryTimestamp(query.from, "from");
  const to = normalizeAuditQueryTimestamp(query.to, "to");
  return JSON.stringify({
    version: 1,
    resource: "dashboard-audit-counts",
    order: "partition_minute_desc",
    from: from ?? null,
    to: to ?? null,
  });
}

export type DashboardAuditCounts = {
  tokensIssued: number;
  tokensRevoked: number;
  tokensRefreshed: number;
  scopeChecks: number;
  scopeDenials: number;
};

export type DashboardAuditCountsResult =
  | {
      kind: "complete";
      counts: DashboardAuditCounts;
      /** Archive scan counters are returned when a backend performed one. */
      workBudget?: AuditQueryWorkBudget;
    }
  | {
      kind: "budget_exhausted";
      counts: DashboardAuditCounts;
      continuation: AuditArchivePartitionCursor;
      workBudget: AuditQueryWorkBudget;
    };

export type CreateAuditWebhookInput = {
  orgId: string;
  url: string;
  secret: string;
  events?: string[];
};

export type AuditWebhookRecord = {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events?: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationContextRecord = {
  id: string;
  orgId: string;
  scopes: string[];
  roles: string[];
};

export type WorkspaceContextRecord = {
  id: string;
  workspaceId: string;
  orgId: string;
  scopes: string[];
  roles: string[];
};

export type DuplicateIdentityRecord = {
  id: string;
  name: string;
  orgId: string;
};

export type IssuedTokenRecord = {
  id: string;
  tokenId: string;
  jti: string;
  identityId: string;
  sessionId?: string | null;
  issuedAt: number;
  expiresAt: number;
  createdAt: string;
  /**
   * A durable snapshot of the identity lineage at the moment this token was
   * issued. Storage implementations persist this with the token record.
   */
  lineage?: TokenLineageSnapshot;
};

export type TokenLineageSnapshot = {
  orgId: string;
  workspaceId: string;
  sponsorId: string;
  sponsorChain: string[];
  tokenType: "access" | "refresh";
};

export type TokenLineageRecord = TokenLineageSnapshot & {
  tokenId: string;
  identityId: string;
  createdAt: string;
};

export type IdentityLineageRecord = {
  identityId: string;
  orgId: string;
  workspaceId: string;
  sponsorId: string;
  sponsorChain: string[];
  createdAt: string;
  tokens: TokenLineageRecord[];
  /** True when older token history is returned only up to the response limit. */
  tokensTruncated: boolean;
};

export type StoredTokenRecord = {
  id?: string | null;
  tokenId?: string | null;
  jti?: string | null;
  identityId?: string | null;
  /** Immutable authorization ownership captured when the token was issued. */
  orgId?: string | null;
  workspaceId?: string | null;
  status?: string | null;
  sessionId?: string | null;
  expiresAt?: number | string | null;
};

/**
 * Durable mint boundary. Implementations must commit both token rows and the
 * audit entry atomically before callers return the signed token pair.
 *
 * A platform adapter may additionally materialize the audit entry in an
 * outbox, but it must never acknowledge a partial commit.
 */
export type IssuedTokenPairAudit = {
  accessToken: IssuedTokenRecord;
  refreshToken: IssuedTokenRecord;
  auditEntry: AuditLogWriteEntry;
};

export type IssuedTokenAudit = {
  token: IssuedTokenRecord;
  auditEntry: AuditLogWriteEntry;
};

/**
 * Atomic single-use refresh boundary. A successful commit creates the new
 * pair, revokes the presented refresh JTI, and persists both audit entries.
 * A failed commit must leave the old refresh token active and create nothing.
 */
export type IssuedTokenRotationAudit = {
  accessToken: IssuedTokenRecord;
  refreshToken: IssuedTokenRecord;
  previousRefreshToken: {
    id: string;
    identityId: string;
    expiresAt: number;
  };
  refreshedAuditEntry: AuditLogWriteEntry;
  revokedAuditEntry: AuditLogWriteEntry;
};

/**
 * Durable revoke boundary. Implementations must update the affected token
 * rows, record the revoked JTIs, and persist the audit entry as one
 * transaction. A failed audit write must leave every token active.
 */
export type RevokedTokenAudit = {
  identityId: string;
  tokenIds: string[];
  revokedAt: string;
  auditEntry: AuditLogWriteEntry;
};

export interface IdentityStorage {
  list(
    orgId: string,
    options?: ListIdentitiesOptions,
  ): Promise<AgentIdentity[]>;
  get(id: string): Promise<StoredIdentity | null>;
  create(identity: StoredIdentity): Promise<StoredIdentity>;
  update(id: string, patch: Partial<StoredIdentity>): Promise<StoredIdentity>;
  delete(id: string): Promise<void>;
  suspend(id: string, reason: string): Promise<StoredIdentity>;
  retire(id: string, reason?: string): Promise<StoredIdentity>;
  reactivate(id: string): Promise<StoredIdentity>;
  findDuplicate(
    orgId: string,
    name: string,
  ): Promise<DuplicateIdentityRecord | null>;
  loadOrgBudget(orgId: string): Promise<IdentityBudget | undefined>;
  listChildIds(orgId: string, sponsorId: string): Promise<string[]>;
  listChildren(
    orgId: string,
    sponsorId: string,
  ): Promise<IdentityChildSummary[]>;
  getStatusCounts(orgId: string): Promise<IdentityStatusCounts>;
  /**
   * Returns relational lineage snapshots when the storage backend supports
   * them. This stays optional while the external cloud adapter is upgraded;
   * the Node/SQLite implementation always provides it.
   */
  getLineage?(identityId: string): Promise<IdentityLineageRecord | null>;
}

export interface TokenStorage {
  persistIssued(token: IssuedTokenRecord): Promise<void>;
  persistIssuedWithAudit(input: IssuedTokenAudit): Promise<void>;
  persistIssuedPairWithAudit(input: IssuedTokenPairAudit): Promise<void>;
  rotateIssuedPairWithAudit(input: IssuedTokenRotationAudit): Promise<void>;
  getById(tokenId: string): Promise<StoredTokenRecord | null>;
  listActiveByIdentityId(identityId: string): Promise<StoredTokenRecord[]>;
  listActiveBySessionId(sessionId: string): Promise<StoredTokenRecord[]>;
  listActiveIds(identityId: string): Promise<string[]>;
}

export interface RevocationStorage {
  revokeIdentityTokens(
    identityId: string,
    tokenIds: string[],
    revokedAt: string,
  ): Promise<void>;
  revokeIdentityTokensWithAudit(input: RevokedTokenAudit): Promise<void>;
  /**
   * Optionally populate a low-latency cache after the durable transaction
   * commits. Cache failure must not change the durable revoke result.
   */
  cacheRevokedTokens?(
    identityId: string,
    tokenIds: string[],
    revokedAt: string,
    expiresAt?: number,
  ): Promise<void>;
  isRevoked?(tokenId: string): Promise<boolean>;
  revoke?(tokenId: string, expiresAt: number): Promise<void>;
}

export interface RoleStorage {
  create(role: Role): Promise<Role>;
  get(id: string): Promise<Role | null>;
  list(orgId: string, workspaceId?: string): Promise<Role[]>;
  update(id: string, patch: RoleUpdate): Promise<Role>;
  delete(id: string): Promise<void>;
  listByIds(roleIds: string[]): Promise<Role[]>;
}

export interface PolicyStorage {
  create(policy: Policy): Promise<Policy>;
  get(id: string): Promise<Policy | null>;
  list(orgId: string, workspaceId?: string): Promise<Policy[]>;
  update(id: string, patch: PolicyUpdate): Promise<Policy>;
  delete(id: string): Promise<void>;
}

export interface AuditStorage {
  write(entry: AuditLogWriteEntry): Promise<void>;
  writeBatch(entries: AuditLogWriteEntry[]): Promise<void>;
  query(
    query: AuditQueryInput,
    options?: AuditQueryOptions,
  ): Promise<AuditQueryResult>;
  getActionCounts(
    orgId: string,
    query: DashboardAuditQuery,
  ): Promise<DashboardAuditCountsResult>;
  writeIdentitySuspendedEvent(
    identity: StoredIdentity,
    reason: string,
    actorId: string,
  ): Promise<void>;
}

export interface AuditWebhookStorage {
  create(input: CreateAuditWebhookInput): Promise<AuditWebhookRecord>;
  list(orgId: string): Promise<AuditWebhookRecord[]>;
  delete(orgId: string, id: string): Promise<void>;
}

export interface ContextStorage {
  getOrganization(orgId: string): Promise<OrganizationContextRecord | null>;
  getWorkspace(workspaceId: string): Promise<WorkspaceContextRecord | null>;
}

export interface ApiKeyStorage {
  create(input: CreateApiKeyInput): Promise<StoredApiKey>;
  get(id: string): Promise<StoredApiKey | null>;
  getByHash(keyHash: string): Promise<StoredApiKey | null>;
  list(orgId: string, options?: ListApiKeysOptions): Promise<StoredApiKey[]>;
  revoke(id: string, revokedAt: string): Promise<StoredApiKey>;
  touchLastUsed(id: string, usedAt: string): Promise<void>;
}

/** The fixed predecessor for the first entry in every organization chain. */
export const ATTESTATION_LEDGER_GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export type AttestationLedgerEntryType =
  | "attestation.granted"
  | "attestation.issued"
  | "attestation.late"
  | "identity.created"
  | "key.rotated"
  | "checkpoint";

export type AttestationGrant = {
  jti: string;
  orgId: string;
  agentId: string;
  sponsorId: string;
  sponsorChain: string[];
  repo: string;
  taskRef?: string;
  /**
   * The ai-hist session UUID for the Claude Code / Codex session in which the
   * agent was running when this grant was issued. Injected by the relay spawner
   * via RELAY_ATTEST_SESSION_ID; absent for late grants and for agents spawned
   * before that env var was added.
   */
  sessionRef?: string;
  notAfter: string;
  finalizeKeyHash: string;
  redeemedAt?: string;
  late: boolean;
  createdAt: string;
};

export type AttestationLedgerEntry = {
  seq: number;
  orgId: string;
  orgSeq: number;
  entryType: AttestationLedgerEntryType | string;
  jti?: string;
  commitSha?: string;
  repo?: string;
  agentId?: string;
  sponsorId?: string;
  payloadJson: string;
  jws: string;
  prevHash: string;
  entryHash: string;
  createdAt: string;
};

export type AppendAttestationLedgerEntryInput = {
  orgId: string;
  entryType: AttestationLedgerEntryType | string;
  jti?: string;
  commitSha?: string;
  repo?: string;
  agentId?: string;
  sponsorId?: string;
  payload: Record<string, unknown>;
  jws: string;
  createdAt?: string;
};

export type CreateAttestationGrantWithLedgerInput = {
  grant: AttestationGrant;
  ledgerEntry: AppendAttestationLedgerEntryInput;
};

export type RedeemAttestationGrantInput = {
  jti: string;
  finalizeKeyHash: string;
  /**
   * redeemedAt is intentionally NOT a caller-supplied field: the storage
   * implementation stamps it with the wall-clock time inside the atomic
   * redemption transaction, so expiry is enforced against the moment of
   * commit rather than a possibly-stale request-start timestamp.
   */
  ledgerEntries: AppendAttestationLedgerEntryInput[];
};

export interface AttestationStorage {
  /**
   * Persists an identity and its identity.created ledger entry as one atomic
   * operation. Call this instead of identities.create when the caller must
   * fail closed on ledger persistence.
   */
  createIdentityWithLedgerEntry(
    identity: StoredIdentity,
    ledgerEntry: AppendAttestationLedgerEntryInput,
  ): Promise<StoredIdentity>;
  getGrant(jti: string): Promise<AttestationGrant | null>;
  createGrantWithLedgerEntry(
    input: CreateAttestationGrantWithLedgerInput,
  ): Promise<AttestationGrant>;
  appendAttestationLedgerEntry(
    input: AppendAttestationLedgerEntryInput,
  ): Promise<AttestationLedgerEntry>;
  redeemGrantWithLedgerEntries(
    input: RedeemAttestationGrantInput,
  ): Promise<AttestationLedgerEntry[]>;
}

export interface AuthStorage {
  identities: IdentityStorage;
  tokens: TokenStorage;
  revocations: RevocationStorage;
  roles: RoleStorage;
  policies: PolicyStorage;
  audit: AuditStorage;
  auditWebhooks: AuditWebhookStorage;
  contexts: ContextStorage;
  apiKeys: ApiKeyStorage;
  attestations: AttestationStorage;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "storage_error",
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

const ISO_8601_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Validate timestamp input before it becomes part of an audit storage query.
 * Date.parse alone accepts impossible calendar dates on some runtimes.
 */
export function isValidAuditTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = ISO_8601_TIMESTAMP.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function normalizeAuditQueryTimestamp(
  value: string | undefined,
  field: "from" | "to",
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!isValidAuditTimestamp(normalized)) {
    throw new StorageError(
      `${field} must be an ISO 8601 timestamp`,
      400,
      "invalid_input",
    );
  }
  return new Date(Date.parse(normalized)).toISOString();
}

function normalizeAuditEntryCursor(cursor: AuditEntryCursor): AuditEntryCursor {
  if (!isValidAuditTimestamp(cursor.timestamp)) {
    throw new StorageError(
      "audit cursor timestamp must be an ISO 8601 timestamp",
      400,
      "invalid_input",
    );
  }
  if (typeof cursor.id !== "string" || cursor.id.trim().length === 0) {
    throw new StorageError(
      "audit cursor id is required",
      400,
      "invalid_input",
    );
  }

  return {
    ...cursor,
    id: cursor.id.trim(),
    timestamp: new Date(Date.parse(cursor.timestamp)).toISOString(),
  };
}

/**
 * Return the exclusive hot-store upper bound for an archive partition cursor.
 * This is deliberately part of the storage contract: direct callers bypass
 * HTTP validation, and both SQL and in-memory implementations need identical
 * UTC normalization and inclusive-minute arithmetic.
 */
export function normalizeAuditArchiveCursorBoundaries(
  cursor: AuditArchivePartitionCursor,
): {
  cursorTimestamp: string;
  upperBound: string;
  entryCursorTimestamp?: string;
} {
  if (!isValidAuditTimestamp(cursor.timestamp)) {
    throw new StorageError(
      "archive cursor timestamp must be an ISO 8601 timestamp",
      400,
      "invalid_input",
    );
  }

  const cursorTimestamp = new Date(Date.parse(cursor.timestamp)).toISOString();
  const cursorDate = new Date(cursorTimestamp);
  if (
    cursorDate.getUTCSeconds() !== 0 ||
    cursorDate.getUTCMilliseconds() !== 0
  ) {
    throw new StorageError(
      "archive cursor timestamp must be aligned to a UTC minute",
      400,
      "invalid_input",
    );
  }
  let entryCursorTimestamp: string | undefined;

  if (cursor.entryCursor) {
    entryCursorTimestamp = normalizeAuditEntryCursor(
      cursor.entryCursor,
    ).timestamp;
  }

  const upperBound =
    cursor.inclusive && !cursor.chunk
      ? new Date(Date.parse(cursorTimestamp) + 60_000).toISOString()
      : cursorTimestamp;

  return {
    cursorTimestamp,
    upperBound,
    ...(entryCursorTimestamp ? { entryCursorTimestamp } : {}),
  };
}

/**
 * Validate and canonicalize an audit query cursor at the shared storage/codec
 * boundary so SQL and in-memory comparisons use the same UTC values.
 */
export function normalizeAuditQueryCursor(
  cursor: AuditQueryCursor,
): AuditQueryCursor {
  if (cursor.kind !== "archive_partition") {
    return normalizeAuditEntryCursor(cursor);
  }

  const boundaries = normalizeAuditArchiveCursorBoundaries(cursor);
  if (
    cursor.chunk &&
    (cursor.chunk.key.trim().length === 0 ||
      cursor.chunk.sha256.trim().length === 0)
  ) {
    throw new StorageError(
      "archive cursor chunk key and sha256 must be non-empty",
      400,
      "invalid_input",
    );
  }
  return {
    ...cursor,
    timestamp: boundaries.cursorTimestamp,
    ...(cursor.entryCursor
      ? {
          entryCursor: {
            ...cursor.entryCursor,
            id: cursor.entryCursor.id.trim(),
            timestamp: boundaries.entryCursorTimestamp!,
          },
        }
      : {}),
  };
}

export function getAuditArchiveCursorUpperBound(
  cursor: AuditArchivePartitionCursor,
): string {
  return normalizeAuditArchiveCursorBoundaries(cursor).upperBound;
}

export type {
  CreateApiKeyInput,
  IdentityBudget,
  IdentityBudgetUsage,
  ListApiKeysOptions,
  PolicyCondition,
  PolicyEffect,
  StoredApiKey,
  StoredIdentity,
};
