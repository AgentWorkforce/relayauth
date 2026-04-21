import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type {
  AuditLogWriteEntry,
  AuditQueryInput,
  AuditQueryOptions,
  AuthStorage,
  AuditStorage,
  DashboardAuditCounts,
  DashboardAuditQuery,
  PolicyStorage,
  RoleStorage,
} from "./interface.js";
import type { AuditEntryRecord } from "./interface.js";
import type { StoredIdentity } from "./identity-types.js";

type RoleStorageSource = RoleStorage | Pick<AuthStorage, "roles"> | unknown;
type PolicyStorageSource = PolicyStorage | Pick<AuthStorage, "policies"> | unknown;
type AuditStorageSource = AuditStorage | Pick<AuthStorage, "audit"> | unknown;
type AuthStorageSource = AuthStorage | unknown;

type D1PreparedStatementLike = {
  bind(...params: unknown[]): {
    run(): Promise<unknown>;
  };
};

type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
  batch?<T = unknown>(statements: Array<ReturnType<D1PreparedStatementLike["bind"]>>): Promise<T>;
};

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

export function resolveAuthStorage(source: AuthStorageSource): AuthStorage {
  return source as AuthStorage;
}

export function resolveRoleStorage(source: RoleStorageSource): RoleStorage {
  if (typeof source === "object" && source !== null && "roles" in source) {
    return (source as Pick<AuthStorage, "roles">).roles;
  }
  return source as RoleStorage;
}

export function resolvePolicyStorage(source: PolicyStorageSource): PolicyStorage {
  if (typeof source === "object" && source !== null && "policies" in source) {
    return (source as Pick<AuthStorage, "policies">).policies;
  }
  return source as PolicyStorage;
}

export function resolveAuditStorage(source: AuditStorageSource): AuditStorage {
  if (typeof source === "object" && source !== null && "audit" in source) {
    return (source as Pick<AuthStorage, "audit">).audit;
  }
  if (isAuditStorage(source)) {
    return source;
  }
  if (isD1DatabaseLike(source)) {
    return createD1AuditStorage(source);
  }
  return source as AuditStorage;
}

export function resolveContextStorage(c: Context<AppEnv>): AuthStorage {
  const storage = c.get("storage");
  if (!storage) {
    throw new Error("storage not set in context — ensure createApp() receives a storage adapter");
  }
  return storage;
}

function isAuditStorage(source: unknown): source is AuditStorage {
  return (
    typeof source === "object"
    && source !== null
    && typeof (source as Partial<AuditStorage>).write === "function"
  );
}

function isD1DatabaseLike(source: unknown): source is D1DatabaseLike {
  return (
    typeof source === "object"
    && source !== null
    && typeof (source as Partial<D1DatabaseLike>).prepare === "function"
  );
}

function createD1AuditStorage(db: D1DatabaseLike): AuditStorage {
  return {
    async write(entry: AuditLogWriteEntry): Promise<void> {
      await db.prepare(INSERT_AUDIT_LOG_SQL).bind(...toAuditParams(entry)).run();
    },

    async writeBatch(entries: AuditLogWriteEntry[]): Promise<void> {
      if (entries.length === 0) {
        return;
      }

      if (typeof db.batch === "function") {
        const statements = entries.map((entry) =>
          db.prepare(INSERT_AUDIT_LOG_SQL).bind(...toAuditParams(entry)),
        );
        await db.batch(statements);
        return;
      }

      for (const entry of entries) {
        await this.write(entry);
      }
    },

    async query(_query: AuditQueryInput, _options?: AuditQueryOptions): Promise<AuditEntryRecord[]> {
      throw new Error("D1 audit storage adapter does not support query()");
    },

    async getActionCounts(_orgId: string, _query: DashboardAuditQuery): Promise<DashboardAuditCounts> {
      throw new Error("D1 audit storage adapter does not support getActionCounts()");
    },

    async writeIdentitySuspendedEvent(_identity: StoredIdentity, _reason: string, _actorId: string): Promise<void> {
      throw new Error("D1 audit storage adapter does not support writeIdentitySuspendedEvent()");
    },
  };
}

function toAuditParams(entry: AuditLogWriteEntry): unknown[] {
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
