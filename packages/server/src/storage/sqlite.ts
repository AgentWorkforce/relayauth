import type {
  AgentIdentity,
  AuditAction,
  AuditEntry,
  IdentityStatus,
  IdentityType,
  Policy,
  Role,
} from "@relayauth/types";
import type {
  IdentityBudget,
  IdentityBudgetUsage,
  StoredIdentity,
} from "./identity-types.js";
import type {
  AuditEntryRecord,
  AuditStorage,
  AuditWebhookStorage,
  AuditLogWriteEntry,
  AuditQueryInput,
  AuditQueryOptions,
  AuditWebhookRecord,
  AuthStorage,
  ContextStorage,
  CreateAuditWebhookInput,
  DashboardAuditCounts,
  DashboardAuditQuery,
  DuplicateIdentityRecord,
  IdentityChildSummary,
  IdentityStorage,
  IdentityStatusCounts,
  ListIdentitiesOptions,
  OrganizationContextRecord,
  PolicyStorage,
  PolicyUpdate,
  RevocationStorage,
  RoleStorage,
  TokenStorage,
  RoleUpdate,
  WorkspaceContextRecord,
} from "./interface.js";
import { StorageError } from "./interface.js";
import { emitObserverEvent, now as observerNow } from "../lib/events.js";

const DEFAULT_DB_PATH = ".relay/relayauth.db";
const DEFAULT_INTERNAL_SECRET = "internal-test-secret";

/**
 * D1-compatible shim for test helpers that access .DB.prepare().
 * Wraps better-sqlite3's synchronous API in D1's async interface.
 */
interface D1PreparedResult {
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
  first<T = unknown>(): Promise<T | null>;
}

export interface D1Shim {
  prepare(sql: string): D1PreparedResult & {
    bind(...params: unknown[]): D1PreparedResult;
  };
  exec(sql: string): Promise<void>;
}

export type SqliteStorage = AuthStorage & {
  revocations: RevocationStorage & {
    revoke(jti: string, expiresAt: number): Promise<void>;
    isRevoked(jti: string): Promise<boolean>;
  };
  /** D1-compatible shim for test helpers — wraps better-sqlite3 in D1's async API */
  DB: D1Shim;
  INTERNAL_SECRET: string;
  SIGNING_KEY?: string;
  SIGNING_KEY_ID?: string;
  BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  close(): Promise<void> | void;
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'agent',
    org_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    sponsor_id TEXT NOT NULL,
    sponsor_chain_json TEXT NOT NULL DEFAULT '[]',
    scopes_json TEXT NOT NULL DEFAULT '[]',
    roles_json TEXT NOT NULL DEFAULT '[]',
    budget_json TEXT,
    budget_usage_json TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT,
    suspended_at TEXT,
    suspend_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_identities_org_created
    ON identities (org_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_identities_org_sponsor
    ON identities (org_id, sponsor_id);
  CREATE INDEX IF NOT EXISTS idx_identities_org_name
    ON identities (org_id, name);

  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    org_id TEXT NOT NULL,
    workspace_id TEXT,
    built_in INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_roles_org_name
    ON roles (org_id, name, workspace_id);

  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    name TEXT NOT NULL,
    effect TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    conditions_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    org_id TEXT NOT NULL,
    workspace_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_policies_org_workspace_priority
    ON policies (org_id, workspace_id, priority DESC, id ASC);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    identity_id TEXT,
    org_id TEXT NOT NULL,
    workspace_id TEXT,
    plane TEXT,
    resource TEXT,
    result TEXT NOT NULL,
    metadata_json TEXT,
    ip TEXT,
    user_agent TEXT,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp
    ON audit_logs (org_id, timestamp DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_identity_timestamp
    ON audit_logs (identity_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    workspace_id TEXT,
    identity_id TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    payload TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
    ON audit_events (org_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    token_id TEXT,
    jti TEXT,
    identity_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_identity_status
    ON tokens (identity_id, status);

  CREATE TABLE IF NOT EXISTS org_budgets (
    org_id TEXT PRIMARY KEY,
    budget TEXT,
    budget_json TEXT,
    default_budget TEXT,
    settings_json TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    org_id TEXT,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    roles_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    org_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    roles_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS audit_webhooks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_webhooks_org_created
    ON audit_webhooks (org_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS audit_retention_config (
    org_id TEXT PRIMARY KEY,
    retention_days INTEGER NOT NULL DEFAULT 90
  );
`;

const INSERT_IDENTITY_SQL = `
  INSERT INTO identities (
    id,
    data,
    name,
    type,
    org_id,
    workspace_id,
    sponsor_id,
    sponsor_chain_json,
    scopes_json,
    roles_json,
    budget_json,
    budget_usage_json,
    status,
    metadata_json,
    created_at,
    updated_at,
    last_active_at,
    suspended_at,
    suspend_reason
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_IDENTITY_SQL = `
  UPDATE identities
  SET data = ?,
      name = ?,
      type = ?,
      org_id = ?,
      workspace_id = ?,
      sponsor_id = ?,
      sponsor_chain_json = ?,
      scopes_json = ?,
      roles_json = ?,
      budget_json = ?,
      budget_usage_json = ?,
      status = ?,
      metadata_json = ?,
      created_at = ?,
      updated_at = ?,
      last_active_at = ?,
      suspended_at = ?,
      suspend_reason = ?
  WHERE id = ?
`;

const SELECT_STORED_IDENTITY_SQL = `
  SELECT data
  FROM identities
  WHERE id = ?
  LIMIT 1
`;

const LIST_IDENTITIES_SQL = `
  SELECT data
  FROM identities
  WHERE org_id = ?
`;

const FIND_DUPLICATE_IDENTITY_SQL = `
  SELECT id, name, org_id
  FROM identities
  WHERE org_id = ? AND name = ?
  LIMIT 1
`;

const LIST_CHILD_IDS_SQL = `
  SELECT id
  FROM identities
  WHERE org_id = ? AND sponsor_id = ?
  ORDER BY created_at DESC, id DESC
`;

const LIST_CHILDREN_SQL = `
  SELECT id, name, status, sponsor_id, created_at
  FROM identities
  WHERE org_id = ? AND sponsor_id = ?
  ORDER BY created_at DESC, id DESC
`;

const STATUS_COUNTS_SQL = `
  SELECT status, COUNT(*) AS count
  FROM identities
  WHERE org_id = ? AND status IN ('active', 'suspended')
  GROUP BY status
`;

const DELETE_IDENTITY_SQL = `
  DELETE FROM identities
  WHERE id = ?
`;

const INSERT_ROLE_SQL = `
  INSERT INTO roles (
    id,
    name,
    description,
    scopes_json,
    data,
    org_id,
    workspace_id,
    built_in,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_ROLE_SQL = `
  UPDATE roles
  SET name = ?,
      description = ?,
      scopes_json = COALESCE(?, ?)
  WHERE id = ? AND org_id = ?
`;

const SELECT_ROLE_SQL = `
  SELECT id, name, description, scopes_json, org_id, workspace_id, built_in, created_at
  FROM roles
  WHERE id = ?
  LIMIT 1
`;

const LIST_ROLES_SQL = `
  SELECT id, name, description, scopes_json, org_id, workspace_id, built_in, created_at
  FROM roles
  WHERE org_id = ?
  ORDER BY name ASC, id ASC
`;

const LIST_ROLES_FOR_WORKSPACE_SQL = `
  SELECT id, name, description, scopes_json, org_id, workspace_id, built_in, created_at
  FROM roles
  WHERE org_id = ?
    AND (workspace_id = ? OR workspace_id IS NULL)
  ORDER BY name ASC, id ASC
`;

const DELETE_ROLE_SQL = `
  DELETE FROM roles
  WHERE id = ? AND org_id = ?
`;

const INSERT_POLICY_SQL = `
  INSERT INTO policies (
    id,
    name,
    effect,
    scopes_json,
    data,
    conditions_json,
    priority,
    org_id,
    workspace_id,
    created_at,
    deleted_at
  )
  VALUES (?, ?, ?, ?, ?, COALESCE(?, ?), ?, ?, ?, ?, ?)
`;

const UPDATE_POLICY_SQL = `
  UPDATE policies
  SET name = ?,
      effect = ?,
      scopes_json = COALESCE(?, ?),
      conditions_json = COALESCE(?, ?),
      priority = ?
  WHERE id = ? AND org_id = ? AND deleted_at IS NULL
`;

const SELECT_POLICY_SQL = `
  SELECT id, name, effect, scopes_json, conditions_json, priority, org_id, workspace_id, created_at, deleted_at
  FROM policies
  WHERE id = ? AND deleted_at IS NULL
  LIMIT 1
`;

const LIST_POLICIES_SQL = `
  SELECT id, name, effect, scopes_json, conditions_json, priority, org_id, workspace_id, created_at, deleted_at
  FROM policies
  WHERE org_id = ? AND deleted_at IS NULL
  ORDER BY priority DESC, id ASC
`;

const LIST_POLICIES_FOR_WORKSPACE_SQL = `
  SELECT id, name, effect, scopes_json, conditions_json, priority, org_id, workspace_id, created_at, deleted_at
  FROM policies
  WHERE org_id = ?
    AND deleted_at IS NULL
    AND (workspace_id = ? OR workspace_id IS NULL)
  ORDER BY priority DESC, id ASC
`;

const DELETE_POLICY_SQL = `
  UPDATE policies
  SET deleted_at = ?
  WHERE id = ? AND org_id = ? AND deleted_at IS NULL
`;

const LIST_ACTIVE_TOKENS_SQL = `
  SELECT id, jti, token_id
  FROM tokens
  WHERE identity_id = ? AND status = 'active'
`;

const CREATE_REVOKED_TOKENS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )
`;

const CREATE_REVOKED_TOKENS_EXPIRES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
    ON revoked_tokens (expires_at)
`;

const UPSERT_REVOKED_TOKEN_SQL = `
  INSERT OR REPLACE INTO revoked_tokens (jti, expires_at)
  VALUES (?, ?)
`;

const SELECT_REVOKED_TOKEN_SQL = `
  SELECT EXISTS(
    SELECT 1
    FROM revoked_tokens
    WHERE jti = ? AND expires_at > ?
  ) AS found
`;

const SELECT_REVOKED_TOKEN_RECORD_SQL = `
  SELECT expires_at
  FROM revoked_tokens
  WHERE jti = ?
  LIMIT 1
`;

const DELETE_REVOKED_TOKEN_SQL = `
  DELETE FROM revoked_tokens
  WHERE jti = ?
`;

const DELETE_EXPIRED_REVOKED_TOKENS_SQL = `
  DELETE FROM revoked_tokens
  WHERE expires_at <= ?
`;

const UPDATE_TOKEN_STATUS_SQL = `
  UPDATE tokens
  SET status = 'revoked'
  WHERE identity_id = ?
    AND (id = ? OR token_id = ? OR jti = ?)
`;

const UPDATE_TOKEN_STATUS_BY_TOKEN_SQL = `
  UPDATE tokens
  SET status = 'revoked'
  WHERE id = ? OR token_id = ? OR jti = ?
`;

const INSERT_AUDIT_LOG_SQL = `
  INSERT INTO audit_logs (
    id,
    action,
    identity_id,
    org_id,
    workspace_id,
    plane,
    resource,
    result,
    metadata_json,
    ip,
    user_agent,
    timestamp
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_AUDIT_EVENT_SQL = `
  INSERT INTO audit_events (
    id,
    org_id,
    workspace_id,
    identity_id,
    action,
    reason,
    payload,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_AUDIT_WEBHOOK_SQL = `
  INSERT INTO audit_webhooks (
    id,
    org_id,
    url,
    secret,
    events_json,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const LIST_AUDIT_WEBHOOKS_SQL = `
  SELECT id, org_id, url, secret, events_json, created_at, updated_at
  FROM audit_webhooks
  WHERE org_id = ?
  ORDER BY created_at DESC, id DESC
`;

const DELETE_AUDIT_WEBHOOK_SQL = `
  DELETE FROM audit_webhooks
  WHERE org_id = ? AND id = ?
`;

const SELECT_ORG_BUDGET_SQL = `
  SELECT budget, budget_json, default_budget, settings_json, data
  FROM org_budgets
  WHERE org_id = ?
  LIMIT 1
`;

const SELECT_ORGANIZATION_SQL = `
  SELECT id, org_id, scopes_json, roles_json
  FROM organizations
  WHERE id = ?
  LIMIT 1
`;

const SELECT_WORKSPACE_SQL = `
  SELECT id, workspace_id, org_id, scopes_json, roles_json
  FROM workspaces
  WHERE id = ?
  LIMIT 1
`;

type DynamicImportFunction = <T = unknown>(specifier: string) => Promise<T>;

type SqliteRunResult = {
  changes?: number | bigint;
};

type SqliteRow = Record<string, unknown>;

interface SqliteStatement<Row extends SqliteRow = SqliteRow> {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

interface SqliteDatabase {
  pragma(statement: string): unknown;
  exec(sql: string): unknown;
  prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row>;
  close?(): void;
}

type SqliteDatabaseConstructor = new (filename: string) => SqliteDatabase;

type DataRow = { data: string };
type StoredIdentityRow = {
  data?: string;
  id?: string;
  name?: string;
  type?: string | null;
  orgId?: string;
  org_id?: string;
  status?: string | null;
  scopes?: unknown;
  scopes_json?: string | null;
  roles?: unknown;
  roles_json?: string | null;
  metadata?: unknown;
  metadata_json?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  sponsorId?: string;
  sponsor_id?: string;
  sponsorChain?: unknown;
  sponsor_chain?: unknown;
  sponsor_chain_json?: string | null;
  workspaceId?: string;
  workspace_id?: string;
  budget?: IdentityBudget | null;
  budget_json?: string | null;
  budgetUsage?: IdentityBudgetUsage | null;
  budget_usage?: IdentityBudgetUsage | null;
  budget_usage_json?: string | null;
  lastActiveAt?: string | null;
  last_active_at?: string | null;
  suspendedAt?: string | null;
  suspended_at?: string | null;
  suspendReason?: string | null;
  suspend_reason?: string | null;
};
type DuplicateIdentityRow = { id?: string; name?: string; org_id?: string };
type ChildIdentityRow = {
  id?: string;
  name?: string;
  status?: string;
  sponsor_id?: string | null;
  created_at?: string | null;
};
type StatusCountRow = { status?: string | null; count?: number | string | null };
type ActiveTokenRow = { id?: string; jti?: string; token_id?: string };
type ExistsRow = { found?: number | string | bigint | null };
type RevokedTokenRow = { expires_at?: number | string | null };
type TableInfoRow = { name?: string | null };
type RoleRow = {
  id?: string;
  name?: string;
  description?: string;
  scopes?: unknown;
  scopes_json?: string | null;
  org_id?: string;
  workspace_id?: string | null;
  built_in?: number | boolean | null;
  created_at?: string;
};
type PolicyRow = {
  id?: string;
  name?: string;
  effect?: Policy["effect"] | string;
  scopes?: unknown;
  scopes_json?: string | null;
  conditions?: unknown;
  conditions_json?: string | null;
  priority?: number | string | null;
  org_id?: string;
  workspace_id?: string | null;
  created_at?: string;
  deleted_at?: string | null;
};
type AuditRow = {
  id?: string;
  action?: AuditAction | string;
  identity_id?: string | null;
  org_id?: string;
  workspace_id?: string | null;
  plane?: string | null;
  resource?: string | null;
  result?: AuditEntry["result"];
  metadata_json?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  timestamp?: string;
  created_at?: string | null;
};
type AuditCountRow = {
  tokensIssued?: number | string | null;
  tokensRevoked?: number | string | null;
  tokensRefreshed?: number | string | null;
  scopeChecks?: number | string | null;
  scopeDenials?: number | string | null;
};
type AuditWebhookRow = {
  id?: string;
  org_id?: string;
  url?: string;
  secret?: string;
  events_json?: string | null;
  created_at?: string;
  updated_at?: string;
};
type OrgBudgetRow = {
  budget?: IdentityBudget | null;
  budget_json?: string | null;
  default_budget?: string | null;
  settings_json?: string | null;
  data?: string | null;
};
type OrganizationRow = {
  id?: string;
  org_id?: string | null;
  scopes_json?: string | null;
  roles_json?: string | null;
};
type WorkspaceRow = {
  id?: string;
  workspace_id?: string | null;
  org_id?: string | null;
  scopes_json?: string | null;
  roles_json?: string | null;
};

type BudgetPolicyResult = {
  identity: StoredIdentity;
  shouldWriteAuditEvent: boolean;
};

type MemoryTokenRecord = {
  id: string;
  tokenId?: string;
  jti?: string;
  identityId: string;
  status: string;
  createdAt: string;
};

type RevokedTokenRecord = {
  expiresAt: number;
  identityId?: string;
  revokedAt?: string;
};

type MemoryState = {
  identities: Map<string, StoredIdentity>;
  roles: Map<string, Role>;
  policies: Map<string, Policy>;
  auditLogs: AuditEntryRecord[];
  auditWebhooks: Map<string, AuditWebhookRecord>;
  organizations: Map<string, OrganizationContextRecord>;
  workspaces: Map<string, WorkspaceContextRecord>;
  orgBudgets: Map<string, IdentityBudget | undefined>;
  tokens: Map<string, MemoryTokenRecord>;
  revokedTokens: Map<string, RevokedTokenRecord>;
};

type BackendContext =
  | { kind: "sqlite"; db: SqliteDatabase }
  | { kind: "memory"; state: MemoryState };

const dynamicImport = Function("specifier", "return import(specifier)") as DynamicImportFunction;
const MAX_REVOCATION_EXPIRY = 253402300799;

export function createSqliteStorage(dbPath?: string): SqliteStorage {
  const provider = new BackendProvider(dbPath ?? DEFAULT_DB_PATH);
  const revocations = new SqliteRevocationStorage(provider);
  const storage: AuthStorage = {
    identities: new SqliteIdentityStorage(provider),
    tokens: new SqliteTokenStorage(provider),
    revocations,
    roles: new SqliteRoleStorage(provider),
    policies: new SqlitePolicyStorage(provider),
    audit: new SqliteAuditStorage(provider),
    auditWebhooks: new SqliteAuditWebhookStorage(provider),
    contexts: new SqliteContextStorage(provider),
  };

  // D1-compatible shim so test helpers that access .DB.prepare() still work
  const DB: D1Shim = {
    prepare(sql: string) {
      function makeMethods(params: unknown[]): D1PreparedResult {
        return {
          async all<T = unknown>() {
            const backend = await provider.getBackend();
            if (backend.kind !== "sqlite") return { results: [] as T[] };
            const stmt = backend.db.prepare(sql);
            return { results: (params.length ? stmt.all(...params) : stmt.all()) as T[] };
          },
          async run() {
            const backend = await provider.getBackend();
            if (backend.kind !== "sqlite") return { success: true, meta: { changes: 0 } };
            const stmt = backend.db.prepare(sql);
            const result = params.length ? stmt.run(...params) : stmt.run();
            return { success: true, meta: { changes: result.changes ?? 0 } };
          },
          async first<T = unknown>() {
            const backend = await provider.getBackend();
            if (backend.kind !== "sqlite") return null as T | null;
            const stmt = backend.db.prepare(sql);
            return (params.length ? stmt.get(...params) : stmt.get()) as T | null;
          },
        };
      }

      // Return all/run/first directly (no bind) AND via bind()
      return {
        ...makeMethods([]),
        bind(...params: unknown[]) {
          return makeMethods(params);
        },
      };
    },
    async exec(sql: string) {
      const backend = await provider.getBackend();
      if (backend.kind === "sqlite") backend.db.exec(sql);
    },
  };

  return Object.assign(storage, {
    revocations: Object.assign(revocations, {
      revoke: async (jti: string, expiresAt: number) => {
        const normalizedJti = requireString(jti, "jti is required");
        const normalizedExpiresAt = requireUnixTimestamp(expiresAt, "expiresAt is required");
        const backend = await provider.getBackend();
        pruneExpiredRevocations(backend);

        if (normalizedExpiresAt <= nowUnixSeconds()) {
          if (backend.kind === "memory") {
            backend.state.revokedTokens.delete(normalizedJti);
            return;
          }

          backend.db.prepare(DELETE_REVOKED_TOKEN_SQL).run(normalizedJti);
          return;
        }

        if (backend.kind === "memory") {
          backend.state.revokedTokens.set(normalizedJti, { expiresAt: normalizedExpiresAt });
          for (const token of backend.state.tokens.values()) {
            if (token.id === normalizedJti || token.jti === normalizedJti || token.tokenId === normalizedJti) {
              token.status = "revoked";
            }
          }
          return;
        }

        backend.db.prepare(UPSERT_REVOKED_TOKEN_SQL).run(normalizedJti, normalizedExpiresAt);
        backend.db.prepare(UPDATE_TOKEN_STATUS_BY_TOKEN_SQL).run(normalizedJti, normalizedJti, normalizedJti);
      },
    }),
    DB,
    INTERNAL_SECRET: DEFAULT_INTERNAL_SECRET,
    SIGNING_KEY: undefined,
    SIGNING_KEY_ID: undefined,
    BASE_URL: undefined,
    ALLOWED_ORIGINS: undefined,
    close: () => provider.close(),
  });
}
function normalizeRevocationKey(key: string): string {
  return key.startsWith("revoked:") ? key.slice("revoked:".length) : key;
}

class BackendProvider {
  private backendPromise: Promise<BackendContext> | null = null;

  constructor(private readonly dbPath: string) {}

  async getBackend(): Promise<BackendContext> {
    if (!this.backendPromise) {
      this.backendPromise = this.initialize();
    }

    return this.backendPromise;
  }

  async close(): Promise<void> {
    if (!this.backendPromise) {
      return;
    }

    const backend = await this.backendPromise;
    if (backend.kind === "sqlite" && typeof backend.db.close === "function") {
      backend.db.close();
    }
  }

  private async initialize(): Promise<BackendContext> {
    const candidates = await loadSqliteConstructors();

    for (const Database of candidates) {
      try {
        await ensureDbDirectory(this.dbPath);
        const db = new Database(this.dbPath);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.exec(SCHEMA_SQL);
        ensureRevokedTokensSchema(db);
        return { kind: "sqlite", db };
      } catch {
        // Try the next SQLite implementation before falling back to memory.
      }
    }

    return createMemoryBackend();
  }
}

class SqliteIdentityStorage implements IdentityStorage {
  constructor(private readonly provider: BackendProvider) {}

  async list(orgId: string, options: ListIdentitiesOptions = {}): Promise<AgentIdentity[]> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const limit = normalizeLimit(options.limit);
    const cursorId = normalizeOptionalString(options.cursorId);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.identities.values()]
        .filter((identity) => identity.orgId === normalizedOrgId)
        .filter((identity) => !options.status || identity.status === options.status)
        .filter((identity) => !options.type || identity.type === options.type)
        .sort(compareIdentityDesc)
        .filter((identity) => {
          if (!cursorId) {
            return true;
          }

          return compareIdentityCursor(identity, backend.state.identities.get(cursorId) ?? null) < 0;
        })
        .slice(0, limit)
        .map((identity) => toAgentIdentity(identity));
    }

    const rows = backend.db.prepare<DataRow>(LIST_IDENTITIES_SQL).all(normalizedOrgId);
    const cursorIdentity = cursorId ? await this.get(cursorId) : null;

    return rows
      .map((row) => parseStoredIdentity(row.data))
      .filter((identity) => identity.orgId === normalizedOrgId)
      .filter((identity) => !options.status || identity.status === options.status)
      .filter((identity) => !options.type || identity.type === options.type)
      .sort(compareIdentityDesc)
      .filter((identity) => compareIdentityCursor(identity, cursorIdentity) < 0)
      .slice(0, limit)
      .map((identity) => toAgentIdentity(identity));
  }

  async get(id: string): Promise<StoredIdentity | null> {
    const identityId = normalizeOptionalString(id);
    if (!identityId) {
      return null;
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      const identity = backend.state.identities.get(identityId);
      return identity ? cloneStoredIdentity(identity) : null;
    }

    const row = backend.db.prepare<DataRow>(SELECT_STORED_IDENTITY_SQL).get(identityId);
    return row ? parseStoredIdentity(row.data) : null;
  }

  async create(identity: StoredIdentity): Promise<StoredIdentity> {
    const normalized = normalizeStoredIdentity(identity, { generateId: true });
    const budgetResult = applyBudgetPolicy(normalized, normalized, normalizeTimestamp(normalized.updatedAt));
    const finalIdentity = budgetResult.identity;
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      if (backend.state.identities.has(finalIdentity.id)) {
        throw new StorageError("identity_already_exists", 409, "identity_already_exists");
      }

      backend.state.identities.set(finalIdentity.id, cloneStoredIdentity(finalIdentity));
      if (budgetResult.shouldWriteAuditEvent) {
        emitBudgetAlert(finalIdentity);
      }
      return cloneStoredIdentity(finalIdentity);
    }

    if (await this.get(finalIdentity.id)) {
      throw new StorageError("identity_already_exists", 409, "identity_already_exists");
    }

    backend.db.prepare(INSERT_IDENTITY_SQL).run(...toIdentityParams(finalIdentity));
    if (budgetResult.shouldWriteAuditEvent) {
      await this.writeBudgetAuditEvent(backend, finalIdentity);
      emitBudgetAlert(finalIdentity);
    }
    return this.getRequired(finalIdentity.id);
  }

  async update(id: string, patch: Partial<StoredIdentity>): Promise<StoredIdentity> {
    const current = await this.getRequired(id);
    const timestamp = nowIso();
    const merged = mergeStoredIdentity(current, patch, timestamp);
    const budgetResult = applyBudgetPolicy(current, merged, timestamp);
    const finalIdentity = budgetResult.identity;
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.identities.set(finalIdentity.id, cloneStoredIdentity(finalIdentity));
      if (budgetResult.shouldWriteAuditEvent) {
        emitBudgetAlert(finalIdentity);
      }
      return cloneStoredIdentity(finalIdentity);
    }

    backend.db.prepare(UPDATE_IDENTITY_SQL).run(...toIdentityUpdateParams(finalIdentity), finalIdentity.id);
    if (budgetResult.shouldWriteAuditEvent) {
      await this.writeBudgetAuditEvent(backend, finalIdentity);
      emitBudgetAlert(finalIdentity);
    }
    return this.getRequired(finalIdentity.id);
  }

  async delete(id: string): Promise<void> {
    const current = await this.getRequired(id);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.identities.delete(current.id);
      return;
    }

    backend.db.prepare(DELETE_IDENTITY_SQL).run(current.id);
  }

  async suspend(id: string, reason: string): Promise<StoredIdentity> {
    const current = await this.getRequired(id);
    if (current.status === "suspended") {
      throw new StorageError("Identity is already suspended", 409, "identity_conflict");
    }
    if (current.status === "retired") {
      throw new StorageError("Retired identities cannot be suspended", 409, "identity_conflict");
    }

    const timestamp = nowIso();
    const suspended = normalizeStoredIdentity({
      ...current,
      status: "suspended",
      suspendReason: requireString(reason, "reason is required"),
      suspendedAt: timestamp,
      updatedAt: timestamp,
    });

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      backend.state.identities.set(suspended.id, cloneStoredIdentity(suspended));
      return cloneStoredIdentity(suspended);
    }

    backend.db.prepare(UPDATE_IDENTITY_SQL).run(...toIdentityUpdateParams(suspended), suspended.id);
    return this.getRequired(suspended.id);
  }

  async retire(id: string, _reason?: string): Promise<StoredIdentity> {
    const current = await this.getRequired(id);
    if (current.status === "retired") {
      throw new StorageError("Identity is already retired", 409, "identity_conflict");
    }
    const timestamp = nowIso();
    const retired = normalizeStoredIdentity({
      ...current,
      status: "retired",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: timestamp,
    });

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      backend.state.identities.set(retired.id, cloneStoredIdentity(retired));
      return cloneStoredIdentity(retired);
    }

    backend.db.prepare(UPDATE_IDENTITY_SQL).run(...toIdentityUpdateParams(retired), retired.id);
    return this.getRequired(retired.id);
  }

  async reactivate(id: string): Promise<StoredIdentity> {
    const current = await this.getRequired(id);
    if (current.status === "active") {
      throw new StorageError("Identity is already active", 409, "identity_conflict");
    }
    if (current.status === "retired") {
      throw new StorageError("Retired identities cannot be reactivated", 409, "identity_conflict");
    }

    const timestamp = nowIso();
    const reactivated = normalizeStoredIdentity({
      ...current,
      status: "active",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: timestamp,
    });

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      backend.state.identities.set(reactivated.id, cloneStoredIdentity(reactivated));
      return cloneStoredIdentity(reactivated);
    }

    backend.db.prepare(UPDATE_IDENTITY_SQL).run(...toIdentityUpdateParams(reactivated), reactivated.id);
    return this.getRequired(reactivated.id);
  }

  async findDuplicate(orgId: string, name: string): Promise<DuplicateIdentityRecord | null> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const normalizedName = requireString(name, "name is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      for (const identity of backend.state.identities.values()) {
        if (identity.orgId === normalizedOrgId && identity.name === normalizedName) {
          return { id: identity.id, name: identity.name, orgId: identity.orgId };
        }
      }
      return null;
    }

    const row = backend.db.prepare<DuplicateIdentityRow>(FIND_DUPLICATE_IDENTITY_SQL).get(normalizedOrgId, normalizedName);
    const id = normalizeOptionalString(row?.id);
    const duplicateOrgId = normalizeOptionalString(row?.org_id);
    return id && duplicateOrgId
      ? { id, name: normalizedName, orgId: duplicateOrgId }
      : null;
  }

  async loadOrgBudget(orgId: string): Promise<IdentityBudget | undefined> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return cloneOptionalJson(backend.state.orgBudgets.get(normalizedOrgId));
    }

    const row = backend.db.prepare<OrgBudgetRow>(SELECT_ORG_BUDGET_SQL).get(normalizedOrgId);
    if (!row) {
      return undefined;
    }

    return (
      parseIdentityBudget(row.budget_json) ??
      parseIdentityBudget(row.default_budget) ??
      parseSettingsBudget(row.settings_json) ??
      parseIdentityBudget(row.data) ??
      cloneOptionalJson(row.budget ?? undefined)
    );
  }

  async listChildIds(orgId: string, sponsorId: string): Promise<string[]> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const normalizedSponsorId = requireString(sponsorId, "sponsorId is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.identities.values()]
        .filter((identity) => identity.orgId === normalizedOrgId && identity.sponsorId === normalizedSponsorId)
        .sort(compareIdentityDesc)
        .map((identity) => identity.id);
    }

    return backend.db
      .prepare<ChildIdentityRow>(LIST_CHILD_IDS_SQL)
      .all(normalizedOrgId, normalizedSponsorId)
      .map((row) => normalizeOptionalString(row.id))
      .filter((id): id is string => Boolean(id));
  }

  async listChildren(orgId: string, sponsorId: string): Promise<IdentityChildSummary[]> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const normalizedSponsorId = requireString(sponsorId, "sponsorId is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.identities.values()]
        .filter((identity) => identity.orgId === normalizedOrgId && identity.sponsorId === normalizedSponsorId)
        .sort(compareIdentityDesc)
        .map((identity) => ({
          id: identity.id,
          name: identity.name,
          status: identity.status,
          sponsorId: identity.sponsorId,
          createdAt: identity.createdAt,
        }));
    }

    return backend.db
      .prepare<ChildIdentityRow>(LIST_CHILDREN_SQL)
      .all(normalizedOrgId, normalizedSponsorId)
      .map((row) => hydrateChildIdentity(row))
      .filter((child): child is IdentityChildSummary => child !== null);
  }

  async getStatusCounts(orgId: string): Promise<IdentityStatusCounts> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      let activeIdentities = 0;
      let suspendedIdentities = 0;

      for (const identity of backend.state.identities.values()) {
        if (identity.orgId !== normalizedOrgId) {
          continue;
        }
        if (identity.status === "active") {
          activeIdentities++;
        }
        if (identity.status === "suspended") {
          suspendedIdentities++;
        }
      }

      return { activeIdentities, suspendedIdentities };
    }

    const rows = backend.db.prepare<StatusCountRow>(STATUS_COUNTS_SQL).all(normalizedOrgId);
    return summarizeIdentityCounts(rows);
  }

  private async getRequired(id: string): Promise<StoredIdentity> {
    const identity = await this.get(id);
    if (!identity) {
      throw new StorageError("identity_not_found", 404, "identity_not_found");
    }

    return identity;
  }

  private async writeBudgetAuditEvent(backend: Extract<BackendContext, { kind: "sqlite" }>, identity: StoredIdentity): Promise<void> {
    const payload = JSON.stringify({
      eventType: "budget.exceeded",
      status: identity.status,
      sponsorId: identity.sponsorId,
      sponsorChain: identity.sponsorChain,
      budget: identity.budget,
      budgetUsage: identity.budgetUsage,
    });

    try {
      backend.db.prepare(INSERT_AUDIT_EVENT_SQL).run(
        crypto.randomUUID(),
        identity.orgId,
        identity.workspaceId,
        identity.id,
        "identity.suspended",
        "budget_exceeded",
        payload,
        identity.updatedAt,
      );
    } catch (error) {
      console.error("Failed to write budget audit event", error);
    }
  }
}

class SqliteTokenStorage implements TokenStorage {
  constructor(private readonly provider: BackendProvider) {}

  async listActiveIds(identityId: string): Promise<string[]> {
    const normalizedIdentityId = requireString(identityId, "identityId is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.tokens.values()]
        .filter((token) => token.identityId === normalizedIdentityId && token.status === "active")
        .map((token) => token.id || token.jti || token.tokenId || "")
        .filter(Boolean);
    }

    return backend.db
      .prepare<ActiveTokenRow>(LIST_ACTIVE_TOKENS_SQL)
      .all(normalizedIdentityId)
      .map((row) => normalizeOptionalString(row.id) ?? normalizeOptionalString(row.jti) ?? normalizeOptionalString(row.token_id))
      .filter((tokenId): tokenId is string => Boolean(tokenId));
  }
}

class SqliteRevocationStorage implements RevocationStorage {
  constructor(private readonly provider: BackendProvider) {}

  async revokeIdentityTokens(identityId: string, tokenIds: string[], revokedAt: string): Promise<void> {
    const normalizedIdentityId = requireString(identityId, "identityId is required");
    const normalizedTokenIds = normalizeStringArray(tokenIds);
    if (normalizedTokenIds.length === 0) {
      return;
    }

    const timestamp = normalizeTimestamp(revokedAt);
    const backend = await this.provider.getBackend();
    pruneExpiredRevocations(backend);

    if (backend.kind === "memory") {
      for (const tokenId of normalizedTokenIds) {
        backend.state.revokedTokens.set(tokenId, {
          expiresAt: MAX_REVOCATION_EXPIRY,
          identityId: normalizedIdentityId,
          revokedAt: timestamp,
        });
        for (const token of backend.state.tokens.values()) {
          if (
            token.identityId === normalizedIdentityId
            && (token.id === tokenId || token.jti === tokenId || token.tokenId === tokenId)
          ) {
            token.status = "revoked";
          }
        }
      }
      return;
    }

    for (const tokenId of normalizedTokenIds) {
      backend.db.prepare(UPSERT_REVOKED_TOKEN_SQL).run(tokenId, MAX_REVOCATION_EXPIRY);
      backend.db.prepare(UPDATE_TOKEN_STATUS_SQL).run(normalizedIdentityId, tokenId, tokenId, tokenId);
    }
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    const normalizedTokenId = normalizeOptionalString(tokenId);
    if (!normalizedTokenId) {
      return false;
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      pruneExpiredRevocations(backend);
      return backend.state.revokedTokens.has(normalizedTokenId);
    }

    pruneExpiredRevocations(backend);
    const row = backend.db.prepare<ExistsRow>(SELECT_REVOKED_TOKEN_SQL).get(normalizedTokenId, nowUnixSeconds());
    return normalizeNumber(row?.found) > 0;
  }
}

class SqliteRoleStorage implements RoleStorage {
  constructor(private readonly provider: BackendProvider) {}

  async create(role: Role): Promise<Role> {
    const normalized = normalizeRole(role);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      if (backend.state.roles.has(normalized.id)) {
        throw new StorageError("role_name_conflict", 409, "role_name_conflict");
      }

      backend.state.roles.set(normalized.id, cloneRole(normalized));
      return cloneRole(normalized);
    }

    backend.db.prepare(INSERT_ROLE_SQL).run(...toRoleParams(normalized));
    return this.getRequired(normalized.id);
  }

  async get(id: string): Promise<Role | null> {
    const roleId = normalizeOptionalString(id);
    if (!roleId) {
      return null;
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      const role = backend.state.roles.get(roleId);
      return role ? cloneRole(role) : null;
    }

    const row = backend.db.prepare<RoleRow>(SELECT_ROLE_SQL).get(roleId);
    return hydrateRole(row);
  }

  async list(orgId: string, workspaceId?: string): Promise<Role[]> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.roles.values()]
        .filter((role) => role.orgId === normalizedOrgId)
        .filter((role) => !normalizedWorkspaceId || !role.workspaceId || role.workspaceId === normalizedWorkspaceId)
        .sort(compareRoleAsc)
        .map((role) => cloneRole(role));
    }

    const rows = normalizedWorkspaceId
      ? backend.db.prepare<RoleRow>(LIST_ROLES_FOR_WORKSPACE_SQL).all(normalizedOrgId, normalizedWorkspaceId)
      : backend.db.prepare<RoleRow>(LIST_ROLES_SQL).all(normalizedOrgId);

    return rows
      .map((row) => hydrateRole(row))
      .filter((role): role is Role => role !== null);
  }

  async update(id: string, patch: RoleUpdate): Promise<Role> {
    const current = await this.getRequired(id);
    const next: Role = normalizeRole({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
    });
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.roles.set(next.id, cloneRole(next));
      return cloneRole(next);
    }

    backend.db.prepare(UPDATE_ROLE_SQL).run(...toRoleUpdateParams(next));
    return this.getRequired(next.id);
  }

  async delete(id: string): Promise<void> {
    const role = await this.getRequired(id);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.roles.delete(role.id);
      return;
    }

    backend.db.prepare(DELETE_ROLE_SQL).run(role.id, role.orgId);
  }

  async listByIds(roleIds: string[]): Promise<Role[]> {
    const normalizedIds = Array.from(new Set(normalizeStringArray(roleIds)));
    if (normalizedIds.length === 0) {
      return [];
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      return normalizedIds
        .map((roleId) => backend.state.roles.get(roleId))
        .filter((role): role is Role => Boolean(role))
        .map((role) => cloneRole(role));
    }

    const roles = await Promise.all(normalizedIds.map((roleId) => this.get(roleId)));
    return roles.filter((role): role is Role => role !== null);
  }

  private async getRequired(id: string): Promise<Role> {
    const role = await this.get(id);
    if (!role) {
      throw new StorageError("role_not_found", 404, "role_not_found");
    }

    return role;
  }
}

class SqlitePolicyStorage implements PolicyStorage {
  constructor(private readonly provider: BackendProvider) {}

  async create(policy: Policy): Promise<Policy> {
    const normalized = normalizePolicy(policy);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      if (backend.state.policies.has(normalized.id)) {
        throw new StorageError("policy_name_conflict", 409, "policy_name_conflict");
      }

      backend.state.policies.set(normalized.id, clonePolicy(normalized));
      return clonePolicy(normalized);
    }

    backend.db.prepare(INSERT_POLICY_SQL).run(...toPolicyParams(normalized));
    return this.getRequired(normalized.id);
  }

  async get(id: string): Promise<Policy | null> {
    const policyId = normalizeOptionalString(id);
    if (!policyId) {
      return null;
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      const policy = backend.state.policies.get(policyId);
      return policy ? clonePolicy(policy) : null;
    }

    const row = backend.db.prepare<PolicyRow>(SELECT_POLICY_SQL).get(policyId);
    return hydratePolicy(row);
  }

  async list(orgId: string, workspaceId?: string): Promise<Policy[]> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.policies.values()]
        .filter((policy) => policy.orgId === normalizedOrgId)
        .filter((policy) => !normalizedWorkspaceId || !policy.workspaceId || policy.workspaceId === normalizedWorkspaceId)
        .sort(comparePolicyDesc)
        .map((policy) => clonePolicy(policy));
    }

    const rows = normalizedWorkspaceId
      ? backend.db.prepare<PolicyRow>(LIST_POLICIES_FOR_WORKSPACE_SQL).all(normalizedOrgId, normalizedWorkspaceId)
      : backend.db.prepare<PolicyRow>(LIST_POLICIES_SQL).all(normalizedOrgId);

    return rows
      .map((row) => hydratePolicy(row))
      .filter((policy): policy is Policy => policy !== null);
  }

  async update(id: string, patch: PolicyUpdate): Promise<Policy> {
    const current = await this.getRequired(id);
    const next = normalizePolicy({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.effect !== undefined ? { effect: patch.effect } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
      ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    });
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.policies.set(next.id, clonePolicy(next));
      return clonePolicy(next);
    }

    backend.db.prepare(UPDATE_POLICY_SQL).run(...toPolicyUpdateParams(next));
    return this.getRequired(next.id);
  }

  async delete(id: string): Promise<void> {
    const policy = await this.getRequired(id);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.policies.delete(policy.id);
      return;
    }

    backend.db.prepare(DELETE_POLICY_SQL).run(new Date().toISOString(), policy.id, policy.orgId);
  }

  private async getRequired(id: string): Promise<Policy> {
    const policy = await this.get(id);
    if (!policy) {
      throw new StorageError("policy_not_found", 404, "policy_not_found");
    }

    return policy;
  }
}

class SqliteAuditStorage implements AuditStorage {
  constructor(private readonly provider: BackendProvider) {}

  async write(entry: AuditLogWriteEntry): Promise<void> {
    const normalized = normalizeAuditWriteEntry(entry);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.auditLogs.push(cloneAuditEntryRecord(normalized));
      backend.state.auditLogs.sort(compareAuditRecordDesc);
      return;
    }

    backend.db.prepare(INSERT_AUDIT_LOG_SQL).run(...toAuditParams(normalized));
  }

  async writeBatch(entries: AuditLogWriteEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.write(entry);
    }
  }

  async query(query: AuditQueryInput, options: AuditQueryOptions = {}): Promise<AuditEntryRecord[]> {
    const normalized = normalizeAuditQuery(query);
    const backend = await this.provider.getBackend();
    const limitWithOverflow = normalized.limit + (options.includeOverflowRow ?? true ? 1 : 0);

    if (backend.kind === "memory") {
      return backend.state.auditLogs
        .filter((entry) => matchesAuditQuery(entry, normalized))
        .sort(compareAuditRecordDesc)
        .slice(0, limitWithOverflow)
        .map((entry) => cloneAuditEntryRecord(entry));
    }

    const statement = buildAuditQuerySql(normalized, limitWithOverflow);
    return backend.db
      .prepare<AuditRow>(statement.sql)
      .all(...statement.params)
      .map((row) => hydrateAuditEntryRecord(row))
      .filter((entry): entry is AuditEntryRecord => entry !== null);
  }

  async getActionCounts(orgId: string, query: DashboardAuditQuery): Promise<DashboardAuditCounts> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const from = normalizeOptionalString(query.from);
    const to = normalizeOptionalString(query.to);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return summarizeAuditCounts(
        backend.state.auditLogs.filter((entry) =>
          entry.orgId === normalizedOrgId
          && (!from || entry.timestamp >= from)
          && (!to || entry.timestamp < to),
        ),
      );
    }

    const statement = buildAuditCountsSql(normalizedOrgId, { from, to });
    const row = backend.db.prepare<AuditCountRow>(statement.sql).get(...statement.params);
    return {
      tokensIssued: normalizeNumber(row?.tokensIssued),
      tokensRevoked: normalizeNumber(row?.tokensRevoked),
      tokensRefreshed: normalizeNumber(row?.tokensRefreshed),
      scopeChecks: normalizeNumber(row?.scopeChecks),
      scopeDenials: normalizeNumber(row?.scopeDenials),
    };
  }

  async writeIdentitySuspendedEvent(identity: StoredIdentity, reason: string, actorId: string): Promise<void> {
    const normalizedReason = requireString(reason, "reason is required");
    const backend = await this.provider.getBackend();
    const payload = JSON.stringify({
      eventType: "identity.suspended",
      status: identity.status,
      sponsorId: identity.sponsorId,
      sponsorChain: identity.sponsorChain,
      actorId,
      reason: normalizedReason,
    });

    if (backend.kind === "memory") {
      return;
    }

    try {
      backend.db.prepare(INSERT_AUDIT_EVENT_SQL).run(
        crypto.randomUUID(),
        identity.orgId,
        identity.workspaceId,
        identity.id,
        "identity.suspended",
        normalizedReason,
        payload,
        identity.updatedAt,
      );
    } catch (error) {
      console.error("Failed to write identity suspended audit event", error);
    }
  }
}

class SqliteAuditWebhookStorage implements AuditWebhookStorage {
  constructor(private readonly provider: BackendProvider) {}

  async create(input: CreateAuditWebhookInput): Promise<AuditWebhookRecord> {
    const normalized = normalizeAuditWebhook(input);
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      backend.state.auditWebhooks.set(normalized.id, cloneAuditWebhook(normalized));
      return cloneAuditWebhook(normalized);
    }

    backend.db.prepare(INSERT_AUDIT_WEBHOOK_SQL).run(
      normalized.id,
      normalized.orgId,
      normalized.url,
      normalized.secret,
      normalized.events ? JSON.stringify(normalized.events) : null,
      normalized.createdAt,
      normalized.updatedAt,
    );

    return cloneAuditWebhook(normalized);
  }

  async list(orgId: string): Promise<AuditWebhookRecord[]> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      return [...backend.state.auditWebhooks.values()]
        .filter((webhook) => webhook.orgId === normalizedOrgId)
        .sort(compareWebhookDesc)
        .map((webhook) => cloneAuditWebhook(webhook));
    }

    return backend.db
      .prepare<AuditWebhookRow>(LIST_AUDIT_WEBHOOKS_SQL)
      .all(normalizedOrgId)
      .map((row) => hydrateAuditWebhook(row))
      .filter((webhook): webhook is AuditWebhookRecord => webhook !== null);
  }

  async delete(orgId: string, id: string): Promise<void> {
    const normalizedOrgId = requireString(orgId, "orgId is required");
    const normalizedId = requireString(id, "id is required");
    const backend = await this.provider.getBackend();

    if (backend.kind === "memory") {
      const webhook = backend.state.auditWebhooks.get(normalizedId);
      if (webhook?.orgId === normalizedOrgId) {
        backend.state.auditWebhooks.delete(normalizedId);
      }
      return;
    }

    backend.db.prepare(DELETE_AUDIT_WEBHOOK_SQL).run(normalizedOrgId, normalizedId);
  }
}

class SqliteContextStorage implements ContextStorage {
  constructor(private readonly provider: BackendProvider) {}

  async getOrganization(orgId: string): Promise<OrganizationContextRecord | null> {
    const normalizedOrgId = normalizeOptionalString(orgId);
    if (!normalizedOrgId) {
      return null;
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      const organization = backend.state.organizations.get(normalizedOrgId);
      return organization ? cloneOrganization(organization) : null;
    }

    const row = backend.db.prepare<OrganizationRow>(SELECT_ORGANIZATION_SQL).get(normalizedOrgId);
    return hydrateOrganization(row);
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceContextRecord | null> {
    const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
    if (!normalizedWorkspaceId) {
      return null;
    }

    const backend = await this.provider.getBackend();
    if (backend.kind === "memory") {
      const workspace = backend.state.workspaces.get(normalizedWorkspaceId);
      return workspace ? cloneWorkspace(workspace) : null;
    }

    const row = backend.db.prepare<WorkspaceRow>(SELECT_WORKSPACE_SQL).get(normalizedWorkspaceId);
    return hydrateWorkspace(row);
  }
}

async function loadSqliteConstructors(): Promise<SqliteDatabaseConstructor[]> {
  const constructors: SqliteDatabaseConstructor[] = [];
  const moduleRecord = await importOptional<Record<string, unknown>>("better-sqlite3");
  if (moduleRecord) {
    const candidate = "default" in moduleRecord ? moduleRecord.default : moduleRecord;
    if (typeof candidate === "function") {
      constructors.push(candidate as SqliteDatabaseConstructor);
    }
  }

  const sqliteModule = await importOptional<{
    DatabaseSync?: new (filename: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...params: unknown[]): SqliteRunResult;
        get(...params: unknown[]): SqliteRow | undefined;
        all(...params: unknown[]): SqliteRow[];
      };
      close(): void;
    };
  }>("node:sqlite");
  if (sqliteModule?.DatabaseSync) {
    const NodeSqlite = sqliteModule.DatabaseSync;

    constructors.push(class NodeSqliteAdapter {
      private readonly db: InstanceType<typeof NodeSqlite>;

      constructor(filename: string) {
        this.db = new NodeSqlite(filename);
      }

      pragma(statement: string): void {
        this.db.exec(`PRAGMA ${statement}`);
      }

      exec(sql: string): void {
        this.db.exec(sql);
      }

      prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row> {
        return this.db.prepare(sql) as unknown as SqliteStatement<Row>;
      }

      close(): void {
        this.db.close();
      }
    } as unknown as SqliteDatabaseConstructor);
  }

  return constructors;
}

async function ensureDbDirectory(dbPath: string): Promise<void> {
  if (dbPath === ":memory:") {
    return;
  }

  const [fsModule, pathModule] = await Promise.all([
    importOptional<{ mkdirSync?: (path: string, options?: { recursive?: boolean }) => void }>("node:fs"),
    importOptional<{ dirname?: (path: string) => string }>("node:path"),
  ]);

  const mkdirSync = fsModule?.mkdirSync;
  const dirname = pathModule?.dirname;
  if (typeof mkdirSync !== "function" || typeof dirname !== "function") {
    return;
  }

  const directory = dirname(dbPath);
  if (directory && directory !== ".") {
    mkdirSync(directory, { recursive: true });
  }
}

async function importOptional<T>(specifier: string): Promise<T | null> {
  try {
    return await dynamicImport<T>(specifier);
  } catch {
    return null;
  }
}

function createMemoryBackend(): BackendContext {
  return {
    kind: "memory",
    state: {
      identities: new Map<string, StoredIdentity>(),
      roles: new Map<string, Role>(),
      policies: new Map<string, Policy>(),
      auditLogs: [],
      auditWebhooks: new Map<string, AuditWebhookRecord>(),
      organizations: new Map<string, OrganizationContextRecord>(),
      workspaces: new Map<string, WorkspaceContextRecord>(),
      orgBudgets: new Map<string, IdentityBudget | undefined>(),
      tokens: new Map<string, MemoryTokenRecord>(),
      revokedTokens: new Map<string, RevokedTokenRecord>(),
    },
  };
}

async function getRevocationRecord(
  provider: BackendProvider,
  jti: string,
): Promise<Pick<RevokedTokenRecord, "expiresAt" | "identityId" | "revokedAt"> | null> {
  const normalizedJti = normalizeOptionalString(jti);
  if (!normalizedJti) {
    return null;
  }

  const backend = await provider.getBackend();
  pruneExpiredRevocations(backend);

  if (backend.kind === "memory") {
    const record = backend.state.revokedTokens.get(normalizedJti);
    if (!record) {
      return null;
    }

    return {
      expiresAt: record.expiresAt,
      ...(record.identityId ? { identityId: record.identityId } : {}),
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    };
  }

  const row = backend.db.prepare<RevokedTokenRow>(SELECT_REVOKED_TOKEN_RECORD_SQL).get(normalizedJti);
  const expiresAt = normalizeRevocationExpiry(row?.expires_at, undefined);
  if (expiresAt === undefined || expiresAt <= nowUnixSeconds()) {
    if (row) {
      backend.db.prepare(DELETE_REVOKED_TOKEN_SQL).run(normalizedJti);
    }
    return null;
  }

  return { expiresAt };
}

function ensureRevokedTokensSchema(db: SqliteDatabase): void {
  const revokedTokensTable = db.prepare<TableInfoRow>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'revoked_tokens'
    LIMIT 1
  `).get();

  if (!normalizeOptionalString(revokedTokensTable?.name)) {
    db.exec(CREATE_REVOKED_TOKENS_TABLE_SQL);
    db.exec(CREATE_REVOKED_TOKENS_EXPIRES_INDEX_SQL);
    return;
  }

  const columns = new Set(
    db.prepare<TableInfoRow>("PRAGMA table_info(revoked_tokens)")
      .all()
      .map((row) => normalizeOptionalString(row.name))
      .filter((name): name is string => Boolean(name)),
  );

  if (columns.has("jti") && columns.has("expires_at")) {
    db.exec(CREATE_REVOKED_TOKENS_EXPIRES_INDEX_SQL);
    return;
  }

  db.exec("DROP TABLE IF EXISTS revoked_tokens__legacy");
  db.exec("ALTER TABLE revoked_tokens RENAME TO revoked_tokens__legacy");
  db.exec(CREATE_REVOKED_TOKENS_TABLE_SQL);
  db.exec(CREATE_REVOKED_TOKENS_EXPIRES_INDEX_SQL);

  const sourceTokenColumn = columns.has("jti") ? "jti" : columns.has("token_id") ? "token_id" : null;
  const sourceExpirySql = columns.has("expires_at") ? `COALESCE(expires_at, ${MAX_REVOCATION_EXPIRY})` : `${MAX_REVOCATION_EXPIRY}`;

  if (sourceTokenColumn) {
    db.exec(`
      INSERT OR IGNORE INTO revoked_tokens (jti, expires_at)
      SELECT ${sourceTokenColumn}, ${sourceExpirySql}
      FROM revoked_tokens__legacy
      WHERE ${sourceTokenColumn} IS NOT NULL AND TRIM(${sourceTokenColumn}) <> ''
    `);
  }

  db.exec("DROP TABLE revoked_tokens__legacy");
}

function pruneExpiredRevocations(backend: BackendContext): void {
  const now = nowUnixSeconds();

  if (backend.kind === "memory") {
    for (const [jti, record] of backend.state.revokedTokens.entries()) {
      if (record.expiresAt <= now) {
        backend.state.revokedTokens.delete(jti);
      }
    }
    return;
  }

  backend.db.prepare(DELETE_EXPIRED_REVOKED_TOKENS_SQL).run(now);
}

function normalizeStoredIdentity(
  identity: StoredIdentity,
  options: { generateId?: boolean } = {},
): StoredIdentity {
  const providedId = normalizeOptionalString(identity.id);
  const id = providedId ?? (options.generateId ? createGeneratedIdentityId() : undefined);
  if (!id) {
    throw new StorageError("id is required", 400, "invalid_input");
  }

  const sponsorChain = normalizeStringArray(identity.sponsorChain);
  if (sponsorChain.length === 0) {
    throw new StorageError("sponsorChain is required", 400, "invalid_identity");
  }

  const normalizedSponsorChain = !providedId && options.generateId && sponsorChain.at(-1) !== id
    ? [...sponsorChain, id]
    : sponsorChain;

  return {
    ...identity,
    id,
    name: requireString(identity.name, "name is required"),
    type: normalizeIdentityType(identity.type),
    orgId: requireString(identity.orgId, "orgId is required"),
    workspaceId: requireString(identity.workspaceId, "workspaceId is required"),
    sponsorId: requireString(identity.sponsorId, "sponsorId is required"),
    sponsorChain: normalizedSponsorChain,
    status: normalizeIdentityStatus(identity.status) ?? "active",
    scopes: normalizeStringArray(identity.scopes),
    roles: normalizeStringArray(identity.roles),
    metadata: normalizeRecord(identity.metadata),
    createdAt: normalizeTimestamp(identity.createdAt),
    updatedAt: normalizeTimestamp(identity.updatedAt),
    ...(normalizeOptionalString(identity.lastActiveAt) ? { lastActiveAt: normalizeOptionalString(identity.lastActiveAt) } : {}),
    ...(normalizeOptionalString(identity.suspendedAt) ? { suspendedAt: normalizeOptionalString(identity.suspendedAt) } : {}),
    ...(normalizeOptionalString(identity.suspendReason) ? { suspendReason: normalizeOptionalString(identity.suspendReason) } : {}),
    ...(identity.budget ? { budget: cloneOptionalJson(identity.budget)! } : {}),
    ...(identity.budgetUsage ? { budgetUsage: cloneOptionalJson(identity.budgetUsage)! } : {}),
  };
}

function parseStoredIdentity(data: string): StoredIdentity {
  return normalizeStoredIdentity(JSON.parse(data) as StoredIdentity);
}

function hydrateStoredIdentityRow(row: StoredIdentityRow | undefined): StoredIdentity | null {
  if (!row) {
    return null;
  }

  const serialized = normalizeOptionalString(row.data);
  if (serialized) {
    try {
      return parseStoredIdentity(serialized);
    } catch {
      // Fall back to column-based hydration for D1 test doubles that omit the serialized blob.
    }
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const orgId = normalizeOptionalString(row.org_id ?? row.orgId);
  const workspaceId = normalizeOptionalString(row.workspace_id ?? row.workspaceId);
  const sponsorId = normalizeOptionalString(row.sponsor_id ?? row.sponsorId);
  const createdAt = normalizeOptionalString(row.created_at ?? row.createdAt);
  const updatedAt = normalizeOptionalString(row.updated_at ?? row.updatedAt);
  const sponsorChain = parseStringArrayField(
    row.sponsorChain ?? row.sponsor_chain,
    typeof row.sponsor_chain === "string" ? row.sponsor_chain : row.sponsor_chain_json,
  );
  if (!id || !name || !orgId || !workspaceId || !sponsorId || !createdAt || !updatedAt || sponsorChain.length === 0) {
    return null;
  }

  const metadata = normalizeRecord(parseJsonObjectField(row.metadata, row.metadata_json) ?? {});
  const budget = row.budget ?? parseIdentityBudget(row.budget_json);
  const budgetUsage = parseJsonObjectField<IdentityBudgetUsage>(
    row.budgetUsage ?? row.budget_usage,
    row.budget_usage_json,
  );
  const lastActiveAt = normalizeOptionalString(row.last_active_at ?? row.lastActiveAt);
  const suspendedAt = normalizeOptionalString(row.suspended_at ?? row.suspendedAt);
  const suspendReason = normalizeOptionalString(row.suspend_reason ?? row.suspendReason);

  return normalizeStoredIdentity({
    id,
    name,
    type: (normalizeOptionalString(row.type) ?? "agent") as IdentityType,
    orgId,
    workspaceId,
    sponsorId,
    sponsorChain,
    status: normalizeIdentityStatus(row.status) ?? "active",
    scopes: parseStringArrayField(row.scopes, row.scopes_json),
    roles: parseStringArrayField(row.roles, row.roles_json),
    metadata,
    createdAt,
    updatedAt,
    ...(lastActiveAt ? { lastActiveAt } : {}),
    ...(suspendedAt ? { suspendedAt } : {}),
    ...(suspendReason ? { suspendReason } : {}),
    ...(budget ? { budget: cloneOptionalJson(budget)! } : {}),
    ...(budgetUsage ? { budgetUsage } : {}),
  });
}

function mergeStoredIdentity(
  current: StoredIdentity,
  patch: Partial<StoredIdentity>,
  timestamp: string,
): StoredIdentity {
  const updatedAt = normalizeTimestamp(timestamp);

  return normalizeStoredIdentity({
    ...cloneStoredIdentity(current),
    ...patch,
    id: current.id,
    orgId: current.orgId,
    createdAt: current.createdAt,
    metadata: patch.metadata ? { ...current.metadata, ...normalizeRecord(patch.metadata) } : current.metadata,
    scopes: patch.scopes ?? current.scopes,
    roles: patch.roles ?? current.roles,
    sponsorChain: "sponsorChain" in patch ? normalizeStringArray(patch.sponsorChain) : current.sponsorChain,
    budget: patch.budget ?? current.budget,
    budgetUsage: patch.budgetUsage ?? current.budgetUsage,
    updatedAt,
  });
}

function applyBudgetPolicy(previous: StoredIdentity, identity: StoredIdentity, timestamp: string): BudgetPolicyResult {
  if (identity.status === "retired" || !identity.budget?.autoSuspend || !isBudgetExceeded(identity)) {
    return {
      identity,
      shouldWriteAuditEvent: false,
    };
  }

  return {
    identity: {
      ...identity,
      status: "suspended",
      suspendReason: "budget_exceeded",
      suspendedAt: identity.suspendedAt ?? timestamp,
      updatedAt: timestamp,
    },
    shouldWriteAuditEvent: previous.status !== "suspended" || previous.suspendReason !== "budget_exceeded",
  };
}

function isBudgetExceeded(identity: StoredIdentity): boolean {
  const budget = identity.budget;
  const usage = identity.budgetUsage;
  if (!budget || !usage) {
    return false;
  }

  const actionsExceeded =
    typeof budget.maxActionsPerHour === "number"
      && usage.actionsThisHour > budget.maxActionsPerHour;
  const costExceeded =
    typeof budget.maxCostPerDay === "number"
      && usage.costToday > budget.maxCostPerDay;

  return actionsExceeded || costExceeded;
}

function emitBudgetAlert(identity: StoredIdentity): void {
  const metric = getBudgetMetric(identity);
  if (!metric) {
    return;
  }

  emitObserverEvent({
    type: "budget.alert",
    timestamp: observerNow(),
    payload: {
      id: identity.id,
      org: identity.orgId,
      usage: metric.usage,
      limit: metric.limit,
    },
  });
}

function getBudgetMetric(identity: StoredIdentity): { usage: number; limit: number; ratio: number } | undefined {
  const budget = identity.budget;
  const usage = identity.budgetUsage;
  if (!budget || !usage) {
    return undefined;
  }

  const metrics: { usage: number; limit: number; ratio: number }[] = [];
  if (typeof budget.maxActionsPerHour === "number" && budget.maxActionsPerHour > 0) {
    metrics.push({
      usage: usage.actionsThisHour,
      limit: budget.maxActionsPerHour,
      ratio: usage.actionsThisHour / budget.maxActionsPerHour,
    });
  }

  if (typeof budget.maxCostPerDay === "number" && budget.maxCostPerDay > 0) {
    metrics.push({
      usage: usage.costToday,
      limit: budget.maxCostPerDay,
      ratio: usage.costToday / budget.maxCostPerDay,
    });
  }

  return metrics.sort((left, right) => right.ratio - left.ratio)[0];
}

function toIdentityParams(identity: StoredIdentity): unknown[] {
  return [
    identity.id,
    JSON.stringify(identity),
    identity.name,
    identity.type,
    identity.orgId,
    identity.workspaceId,
    identity.sponsorId,
    JSON.stringify(identity.sponsorChain),
    JSON.stringify(identity.scopes),
    JSON.stringify(identity.roles),
    identity.budget ? JSON.stringify(identity.budget) : null,
    identity.budgetUsage ? JSON.stringify(identity.budgetUsage) : null,
    identity.status,
    JSON.stringify(identity.metadata),
    identity.createdAt,
    identity.updatedAt,
    identity.lastActiveAt ?? null,
    identity.suspendedAt ?? null,
    identity.suspendReason ?? null,
  ];
}

function toIdentityUpdateParams(identity: StoredIdentity): unknown[] {
  return toIdentityParams(identity).slice(1);
}

function toAgentIdentity(identity: StoredIdentity): AgentIdentity {
  return {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    orgId: identity.orgId,
    status: identity.status,
    scopes: [...identity.scopes],
    roles: [...identity.roles],
    metadata: { ...identity.metadata },
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    ...(identity.lastActiveAt ? { lastActiveAt: identity.lastActiveAt } : {}),
    ...(identity.suspendedAt ? { suspendedAt: identity.suspendedAt } : {}),
    ...(identity.suspendReason ? { suspendReason: identity.suspendReason } : {}),
  };
}

function compareIdentityDesc(left: StoredIdentity, right: StoredIdentity): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function compareIdentityCursor(identity: StoredIdentity, cursor: StoredIdentity | null): number {
  if (!cursor) {
    return -1;
  }

  const createdComparison = identity.createdAt.localeCompare(cursor.createdAt);
  if (createdComparison !== 0) {
    return createdComparison;
  }

  return identity.id.localeCompare(cursor.id);
}

function hydrateChildIdentity(row: ChildIdentityRow): IdentityChildSummary | null {
  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    status: normalizeIdentityStatus(row.status) ?? "active",
    ...(normalizeOptionalString(row.sponsor_id) ? { sponsorId: row.sponsor_id ?? undefined } : {}),
    ...(normalizeOptionalString(row.created_at) ? { createdAt: row.created_at ?? undefined } : {}),
  };
}

function summarizeIdentityCounts(rows: StatusCountRow[]): IdentityStatusCounts {
  let activeIdentities = 0;
  let suspendedIdentities = 0;

  for (const row of rows) {
    const count = normalizeNumber(row.count);
    if (row.status === "active") {
      activeIdentities = count;
    }
    if (row.status === "suspended") {
      suspendedIdentities = count;
    }
  }

  return { activeIdentities, suspendedIdentities };
}

function normalizeRole(role: Role): Role {
  return {
    ...role,
    id: requireString(role.id, "role id is required"),
    name: requireString(role.name, "role name is required"),
    description: requireString(role.description, "role description is required"),
    orgId: requireString(role.orgId, "role orgId is required"),
    scopes: normalizeStringArray(role.scopes),
    builtIn: role.builtIn === true,
    createdAt: normalizeTimestamp(role.createdAt),
    ...(normalizeOptionalString(role.workspaceId) ? { workspaceId: role.workspaceId } : {}),
  };
}

function hydrateRole(row: RoleRow | undefined): Role | null {
  const id = normalizeOptionalString(row?.id);
  const name = normalizeOptionalString(row?.name);
  const description = normalizeOptionalString(row?.description);
  const orgId = normalizeOptionalString(row?.org_id);
  const createdAt = normalizeOptionalString(row?.created_at);
  const workspaceId = normalizeOptionalString(row?.workspace_id);
  if (!id || !name || !description || !orgId || !createdAt) {
    return null;
  }

  return normalizeRole({
    id,
    name,
    description,
    scopes: parseStringArrayField(row?.scopes, row?.scopes_json),
    orgId,
    builtIn: row?.built_in === true || row?.built_in === 1,
    createdAt,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

function toRoleParams(role: Role): unknown[] {
  return [
    role.id,
    role.name,
    role.description,
    JSON.stringify(role.scopes),
    JSON.stringify(role),
    role.orgId,
    role.workspaceId ?? null,
    role.builtIn ? 1 : 0,
    role.createdAt,
  ];
}

function toRoleUpdateParams(role: Role): unknown[] {
  return [
    role.name,
    role.description,
    JSON.stringify(role.scopes),
    JSON.stringify(role),
    role.id,
    role.orgId,
  ];
}

function compareRoleAsc(left: Role, right: Role): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function normalizePolicy(policy: Policy): Policy {
  const effect = normalizePolicyEffect(policy.effect);
  if (!effect) {
    throw new StorageError("policy effect is required", 400, "invalid_input");
  }

  return {
    ...policy,
    id: requireString(policy.id, "policy id is required"),
    name: requireString(policy.name, "policy name is required"),
    effect,
    orgId: requireString(policy.orgId, "policy orgId is required"),
    scopes: normalizeStringArray(policy.scopes),
    conditions: normalizePolicyConditions(policy.conditions),
    priority: Number.isInteger(policy.priority) ? policy.priority : 0,
    createdAt: normalizeTimestamp(policy.createdAt),
    ...(normalizeOptionalString(policy.workspaceId) ? { workspaceId: policy.workspaceId } : {}),
  };
}

function hydratePolicy(row: PolicyRow | undefined): Policy | null {
  const id = normalizeOptionalString(row?.id);
  const name = normalizeOptionalString(row?.name);
  const effect = normalizePolicyEffect(row?.effect);
  const orgId = normalizeOptionalString(row?.org_id);
  const createdAt = normalizeOptionalString(row?.created_at);
  const workspaceId = normalizeOptionalString(row?.workspace_id);
  if (!id || !name || !effect || !orgId || !createdAt) {
    return null;
  }

  return normalizePolicy({
    id,
    name,
    effect,
    scopes: parseStringArrayField(row?.scopes, row?.scopes_json),
    conditions: parsePolicyConditionsField(row?.conditions, row?.conditions_json),
    priority: normalizeNumber(row?.priority),
    orgId,
    createdAt,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

function toPolicyParams(policy: Policy): unknown[] {
  return [
    policy.id,
    policy.name,
    policy.effect,
    JSON.stringify(policy.scopes),
    JSON.stringify(policy),
    JSON.stringify(policy.conditions),
    JSON.stringify(policy),
    policy.priority,
    policy.orgId,
    policy.workspaceId ?? null,
    policy.createdAt,
    null,
  ];
}

function toPolicyUpdateParams(policy: Policy): unknown[] {
  return [
    policy.name,
    policy.effect,
    JSON.stringify(policy.scopes),
    JSON.stringify(policy),
    JSON.stringify(policy.conditions),
    JSON.stringify(policy),
    policy.priority,
    policy.id,
    policy.orgId,
  ];
}

function comparePolicyDesc(left: Policy, right: Policy): number {
  return right.priority - left.priority || left.id.localeCompare(right.id);
}

function normalizeAuditWriteEntry(entry: AuditLogWriteEntry): AuditEntryRecord {
  const createdAt = new Date().toISOString();

  return {
    id: normalizeOptionalString(entry.id) ?? `aud_${crypto.randomUUID()}`,
    action: entry.action,
    identityId: requireString(entry.identityId, "identityId is required"),
    orgId: requireString(entry.orgId, "orgId is required"),
    result: entry.result,
    timestamp: normalizeTimestamp(entry.timestamp),
    createdAt,
    ...(normalizeOptionalString(entry.workspaceId) ? { workspaceId: entry.workspaceId } : {}),
    ...(normalizeOptionalString(entry.plane) ? { plane: entry.plane } : {}),
    ...(normalizeOptionalString(entry.resource) ? { resource: entry.resource } : {}),
    ...(entry.metadata ? { metadata: normalizeRecord(entry.metadata) } : {}),
    ...(normalizeOptionalString(entry.ip) ? { ip: entry.ip } : {}),
    ...(normalizeOptionalString(entry.userAgent) ? { userAgent: entry.userAgent } : {}),
  };
}

function normalizeAuditQuery(query: AuditQueryInput): AuditQueryInput {
  return {
    ...query,
    orgId: requireString(query.orgId, "orgId is required"),
    limit: normalizeAuditLimit(query.limit),
  };
}

function toAuditParams(entry: AuditEntryRecord): unknown[] {
  return [
    entry.id,
    entry.action,
    entry.identityId,
    entry.orgId,
    entry.workspaceId ?? null,
    entry.plane ?? null,
    entry.resource ?? null,
    entry.result,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.ip ?? null,
    entry.userAgent ?? null,
    entry.timestamp,
  ];
}

function buildAuditQuerySql(query: AuditQueryInput, limit: number): { sql: string; params: unknown[] } {
  const clauses = ["org_id = ?"];
  const params: unknown[] = [query.orgId];

  if (query.identityId) {
    clauses.push("identity_id = ?");
    params.push(query.identityId);
  }
  if (query.action) {
    clauses.push("action = ?");
    params.push(query.action);
  }
  if (query.workspaceId) {
    clauses.push("workspace_id = ?");
    params.push(query.workspaceId);
  }
  if (query.plane) {
    clauses.push("plane = ?");
    params.push(query.plane);
  }
  if (query.result) {
    clauses.push("result = ?");
    params.push(query.result);
  }
  if (query.from) {
    clauses.push("timestamp >= ?");
    params.push(query.from);
  }
  if (query.to) {
    clauses.push("(timestamp < ?)");
    params.push(query.to);
  }
  if (query.cursor) {
    clauses.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
    params.push(query.cursor.timestamp, query.cursor.timestamp, query.cursor.id);
  }

  params.push(limit);

  return {
    sql: `
      SELECT
        id,
        action,
        identity_id,
        org_id,
        workspace_id,
        plane,
        resource,
        result,
        metadata_json,
        ip,
        user_agent,
        timestamp,
        created_at
      FROM audit_logs
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `,
    params,
  };
}

function buildAuditCountsSql(
  orgId: string,
  query: { from?: string; to?: string },
): { sql: string; params: unknown[] } {
  const clauses = ["org_id = ?"];
  const params: unknown[] = [orgId];

  if (query.from) {
    clauses.push("timestamp >= ?");
    params.push(query.from);
  }
  if (query.to) {
    clauses.push("timestamp < ?");
    params.push(query.to);
  }

  return {
    sql: `
      SELECT
        SUM(CASE WHEN action = 'token.issued' THEN 1 ELSE 0 END) AS tokensIssued,
        SUM(CASE WHEN action = 'token.revoked' THEN 1 ELSE 0 END) AS tokensRevoked,
        SUM(CASE WHEN action = 'token.refreshed' THEN 1 ELSE 0 END) AS tokensRefreshed,
        SUM(CASE WHEN action = 'scope.checked' AND result IN ('allowed', 'denied') THEN 1 ELSE 0 END) AS scopeChecks,
        SUM(CASE WHEN action = 'scope.denied' THEN 1 ELSE 0 END) AS scopeDenials
      FROM audit_logs
      WHERE ${clauses.join(" AND ")}
    `,
    params,
  };
}

function hydrateAuditEntryRecord(row: AuditRow): AuditEntryRecord | null {
  const id = normalizeOptionalString(row.id);
  const action = row.action;
  const identityId = normalizeOptionalString(row.identity_id);
  const orgId = normalizeOptionalString(row.org_id);
  const timestamp = normalizeOptionalString(row.timestamp);
  if (!id || !action || !identityId || !orgId || !timestamp) {
    return null;
  }

  return {
    id,
    action: action as AuditAction,
    identityId,
    orgId,
    result: (row.result ?? "allowed") as AuditEntry["result"],
    timestamp,
    ...(normalizeOptionalString(row.workspace_id) ? { workspaceId: row.workspace_id ?? undefined } : {}),
    ...(normalizeOptionalString(row.plane) ? { plane: row.plane ?? undefined } : {}),
    ...(normalizeOptionalString(row.resource) ? { resource: row.resource ?? undefined } : {}),
    ...(row.metadata_json ? { metadata: normalizeRecord(parseJson<Record<string, unknown>>(row.metadata_json, {})) } : {}),
    ...(normalizeOptionalString(row.ip) ? { ip: row.ip ?? undefined } : {}),
    ...(normalizeOptionalString(row.user_agent) ? { userAgent: row.user_agent ?? undefined } : {}),
    ...(normalizeOptionalString(row.created_at) ? { createdAt: row.created_at ?? undefined } : {}),
  };
}

function matchesAuditQuery(entry: AuditEntryRecord, query: AuditQueryInput): boolean {
  if (entry.orgId !== query.orgId) {
    return false;
  }
  if (query.identityId && entry.identityId !== query.identityId) {
    return false;
  }
  if (query.action && entry.action !== query.action) {
    return false;
  }
  if (query.workspaceId && entry.workspaceId !== query.workspaceId) {
    return false;
  }
  if (query.plane && entry.plane !== query.plane) {
    return false;
  }
  if (query.result && entry.result !== query.result) {
    return false;
  }
  if (query.from && entry.timestamp < query.from) {
    return false;
  }
  if (query.to && entry.timestamp >= query.to) {
    return false;
  }
  if (query.cursor) {
    if (entry.timestamp > query.cursor.timestamp) {
      return false;
    }
    if (entry.timestamp === query.cursor.timestamp && entry.id >= query.cursor.id) {
      return false;
    }
  }

  return true;
}

function summarizeAuditCounts(entries: AuditEntryRecord[]): DashboardAuditCounts {
  let tokensIssued = 0;
  let tokensRevoked = 0;
  let tokensRefreshed = 0;
  let scopeChecks = 0;
  let scopeDenials = 0;

  for (const entry of entries) {
    switch (entry.action) {
      case "token.issued":
        tokensIssued++;
        break;
      case "token.revoked":
        tokensRevoked++;
        break;
      case "token.refreshed":
        tokensRefreshed++;
        break;
      case "scope.checked":
        if (entry.result === "allowed" || entry.result === "denied") {
          scopeChecks++;
        }
        break;
      case "scope.denied":
        scopeDenials++;
        break;
      default:
        break;
    }
  }

  return { tokensIssued, tokensRevoked, tokensRefreshed, scopeChecks, scopeDenials };
}

function compareAuditRecordDesc(left: AuditEntryRecord, right: AuditEntryRecord): number {
  return right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id);
}

function normalizeAuditWebhook(input: CreateAuditWebhookInput): AuditWebhookRecord {
  const timestamp = new Date().toISOString();

  return {
    id: `awh_${crypto.randomUUID()}`,
    orgId: requireString(input.orgId, "orgId is required"),
    url: requireString(input.url, "url is required"),
    secret: requireString(input.secret, "secret is required"),
    ...(input.events ? { events: normalizeStringArray(input.events) } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function hydrateAuditWebhook(row: AuditWebhookRow): AuditWebhookRecord | null {
  const id = normalizeOptionalString(row.id);
  const orgId = normalizeOptionalString(row.org_id);
  const url = normalizeOptionalString(row.url);
  const secret = normalizeOptionalString(row.secret);
  const createdAt = normalizeOptionalString(row.created_at);
  const updatedAt = normalizeOptionalString(row.updated_at);
  if (!id || !orgId || !url || !secret || !createdAt || !updatedAt) {
    return null;
  }

  const events = row.events_json ? normalizeStringArray(parseJson<unknown[]>(row.events_json, [])) : undefined;

  return {
    id,
    orgId,
    url,
    secret,
    ...(events && events.length > 0 ? { events } : {}),
    createdAt,
    updatedAt,
  };
}

function compareWebhookDesc(left: AuditWebhookRecord, right: AuditWebhookRecord): number {
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || right.id.localeCompare(left.id);
}

function hydrateOrganization(row: OrganizationRow | undefined): OrganizationContextRecord | null {
  const id = normalizeOptionalString(row?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    orgId: normalizeOptionalString(row?.org_id) ?? id,
    scopes: normalizeStringArray(parseJson<unknown[]>(row?.scopes_json ?? "[]", [])),
    roles: normalizeStringArray(parseJson<unknown[]>(row?.roles_json ?? "[]", [])),
  };
}

function hydrateWorkspace(row: WorkspaceRow | undefined): WorkspaceContextRecord | null {
  const id = normalizeOptionalString(row?.id);
  const orgId = normalizeOptionalString(row?.org_id);
  if (!id || !orgId) {
    return null;
  }

  return {
    id,
    workspaceId: normalizeOptionalString(row?.workspace_id) ?? id,
    orgId,
    scopes: normalizeStringArray(parseJson<unknown[]>(row?.scopes_json ?? "[]", [])),
    roles: normalizeStringArray(parseJson<unknown[]>(row?.roles_json ?? "[]", [])),
  };
}

function parseIdentityBudget(value: unknown): IdentityBudget | undefined {
  if (isIdentityBudget(value)) {
    return cloneOptionalJson(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = parseJson<unknown>(value, undefined);
  return isIdentityBudget(parsed) ? cloneOptionalJson(parsed) : undefined;
}

function parseSettingsBudget(value: unknown): IdentityBudget | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = parseJson<Record<string, unknown>>(value, {});
  const budget = parsed["budget"];
  return isIdentityBudget(budget) ? cloneOptionalJson(budget) : undefined;
}

function isIdentityBudget(value: unknown): value is IdentityBudget {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdentityType(value: unknown): IdentityType {
  return value === "human" || value === "service" ? value : "agent";
}

function normalizeIdentityStatus(value: unknown): IdentityStatus | undefined {
  return value === "active" || value === "suspended" || value === "retired" ? value : undefined;
}

function normalizePolicyEffect(value: unknown): Policy["effect"] | undefined {
  return value === "allow" || value === "deny" ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseStringArrayField(value: unknown, jsonValue?: string | null): string[] {
  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }

  return normalizeStringArray(parseJson<unknown[]>(jsonValue ?? undefined, []));
}

function normalizePolicyConditions(value: unknown): Policy["conditions"] {
  return Array.isArray(value) ? cloneJsonArray(value as Policy["conditions"]) : [];
}

function parsePolicyConditionsField(value: unknown, jsonValue?: string | null): Policy["conditions"] {
  if (Array.isArray(value)) {
    return normalizePolicyConditions(value);
  }

  return normalizePolicyConditions(parseJson<unknown[]>(jsonValue ?? undefined, []));
}

function parseJsonObjectField<T extends object>(value: unknown, jsonValue?: string | null): T | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return cloneOptionalJson(value as T);
  }

  const parsed = parseJson<unknown>(jsonValue ?? undefined, undefined);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return cloneOptionalJson(parsed as T);
  }

  return undefined;
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return 50;
  }

  // Identity listing fetches limit + 1 internally so callers can detect whether another page exists.
  return Math.min(value, 101);
}

function normalizeAuditLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return 50;
  }

  return Math.min(value, 10_000);
}

function normalizeTimestamp(value: string | undefined): string {
  return normalizeOptionalString(value) ?? new Date().toISOString();
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function requireString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new StorageError(message, 400, "invalid_input");
  }

  return normalized;
}

function parseJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeNumber(value: unknown): number {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function mergeRecordsById<T extends { id: string }>(
  remote: T[],
  local: T[],
  compare: (left: T, right: T) => number,
): T[] {
  const merged = new Map<string, T>();

  for (const record of remote) {
    merged.set(record.id, record);
  }

  for (const record of local) {
    merged.set(record.id, record);
  }

  return [...merged.values()].sort(compare);
}

function normalizeRevocationExpiry(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return fallback;
    }

    const parsedNumber = Number(normalized);
    if (Number.isFinite(parsedNumber)) {
      return Math.max(0, Math.floor(parsedNumber));
    }

    const parsedDate = Date.parse(normalized);
    if (Number.isFinite(parsedDate)) {
      return Math.max(0, Math.floor(parsedDate / 1000));
    }
  }

  return fallback;
}

function requireUnixTimestamp(value: unknown, message: string): number {
  const normalized = normalizeRevocationExpiry(value, undefined);
  if (normalized === undefined) {
    throw new StorageError(message, 400, "invalid_input");
  }

  return normalized;
}

function cloneStoredIdentity(identity: StoredIdentity): StoredIdentity {
  return JSON.parse(JSON.stringify(identity)) as StoredIdentity;
}

function cloneRole(role: Role): Role {
  return JSON.parse(JSON.stringify(role)) as Role;
}

function clonePolicy(policy: Policy): Policy {
  return JSON.parse(JSON.stringify(policy)) as Policy;
}

function cloneAuditEntryRecord(entry: AuditEntryRecord): AuditEntryRecord {
  return JSON.parse(JSON.stringify(entry)) as AuditEntryRecord;
}

function cloneAuditWebhook(webhook: AuditWebhookRecord): AuditWebhookRecord {
  return JSON.parse(JSON.stringify(webhook)) as AuditWebhookRecord;
}

function cloneOrganization(record: OrganizationContextRecord): OrganizationContextRecord {
  return JSON.parse(JSON.stringify(record)) as OrganizationContextRecord;
}

function cloneWorkspace(record: WorkspaceContextRecord): WorkspaceContextRecord {
  return JSON.parse(JSON.stringify(record)) as WorkspaceContextRecord;
}

function cloneOptionalJson<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
}

function cloneJsonArray<T>(value: T[]): T[] {
  return JSON.parse(JSON.stringify(value)) as T[];
}

function toChanges(result: SqliteRunResult): number {
  if (typeof result.changes === "bigint") {
    return Number(result.changes);
  }

  return result.changes ?? 0;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  const parsed = parseJson<unknown>(value, null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function createGeneratedIdentityId(): string {
  return `agent_${crypto.randomUUID().replace(/-/g, "")}`;
}
