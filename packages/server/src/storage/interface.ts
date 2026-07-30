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
  d1Pages: number;
  d1Rows: number;
  partitions: number;
  r2Reads: number;
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
 * the HTTP boundary without copying filter semantics.
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
    | "cursor"
  >,
): string {
  const entryCursor = query.cursor?.kind === "archive_partition"
    ? query.cursor.entryCursor
    : query.cursor;
  return JSON.stringify({
    version: 1,
    resource: "audit",
    order: "timestamp_desc_id_desc",
    identityId: query.identityId ?? null,
    action: query.action ?? null,
    workspaceId: query.workspaceId ?? null,
    plane: query.plane ?? null,
    result: query.result ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    limit: query.limit,
    entryCursor: entryCursor
      ? { timestamp: entryCursor.timestamp, id: entryCursor.id }
      : null,
  });
}

/** Dashboard supports only the documented exact from/to range tuple. */
export function createDashboardAuditContinuationFilterKey(
  query: Pick<DashboardAuditQuery, "from" | "to">,
): string {
  return JSON.stringify({
    version: 1,
    resource: "dashboard-audit-counts",
    order: "partition_minute_desc",
    from: query.from ?? null,
    to: query.to ?? null,
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
};

export type StoredTokenRecord = {
  id?: string | null;
  tokenId?: string | null;
  jti?: string | null;
  identityId?: string | null;
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

export interface IdentityStorage {
  list(orgId: string, options?: ListIdentitiesOptions): Promise<AgentIdentity[]>;
  get(id: string): Promise<StoredIdentity | null>;
  create(identity: StoredIdentity): Promise<StoredIdentity>;
  update(id: string, patch: Partial<StoredIdentity>): Promise<StoredIdentity>;
  delete(id: string): Promise<void>;
  suspend(id: string, reason: string): Promise<StoredIdentity>;
  retire(id: string, reason?: string): Promise<StoredIdentity>;
  reactivate(id: string): Promise<StoredIdentity>;
  findDuplicate(orgId: string, name: string): Promise<DuplicateIdentityRecord | null>;
  loadOrgBudget(orgId: string): Promise<IdentityBudget | undefined>;
  listChildIds(orgId: string, sponsorId: string): Promise<string[]>;
  listChildren(orgId: string, sponsorId: string): Promise<IdentityChildSummary[]>;
  getStatusCounts(orgId: string): Promise<IdentityStatusCounts>;
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
  revokeIdentityTokens(identityId: string, tokenIds: string[], revokedAt: string): Promise<void>;
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
  query(query: AuditQueryInput, options?: AuditQueryOptions): Promise<AuditQueryResult>;
  getActionCounts(orgId: string, query: DashboardAuditQuery): Promise<DashboardAuditCountsResult>;
  writeIdentitySuspendedEvent(identity: StoredIdentity, reason: string, actorId: string): Promise<void>;
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
