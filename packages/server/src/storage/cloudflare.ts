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
} from "../durable-objects/identity-do.js";
import type {
  AuditEntryRecord,
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
  IdentityStatusCounts,
  ListIdentitiesOptions,
  OrganizationContextRecord,
  PolicyUpdate,
  RoleUpdate,
  WorkspaceContextRecord,
} from "./interface.js";
import { StorageError } from "./interface.js";

type CloudflareSqlBindings = {
  DB: D1Database;
};

export type CloudflareStorageBindings = CloudflareSqlBindings & {
  IDENTITY_DO: DurableObjectNamespace;
  REVOCATION_KV: KVNamespace;
  INTERNAL_SECRET: string;
};

export type CloudflareBindings = CloudflareStorageBindings;

type InternalStorageConfig = {
  db: D1Database;
  identityNamespace?: DurableObjectNamespace;
  revocationKv?: KVNamespace;
  internalSecret?: string;
};

type DuplicateIdentityRow = {
  id?: string;
  name?: string;
  orgId?: string;
  org_id?: string;
};

type OrgBudgetRow = {
  budget?: IdentityBudget;
  budget_json?: string;
  defaultBudget?: IdentityBudget;
  default_budget?: string;
  data?: string;
  settings_json?: string;
};

type ChildIdentityRow = {
  id?: string;
  name?: string;
  status?: string;
  sponsorId?: string;
  sponsor_id?: string;
  createdAt?: string;
  created_at?: string;
};

type ActiveTokenRow = {
  id?: string;
  jti?: string;
  tokenId?: string;
  token_id?: string;
};

type ListIdentityRow = {
  id?: string;
  name?: string;
  type?: string;
  orgId?: string;
  org_id?: string;
  status?: string;
  scopes?: string | string[];
  scopes_json?: string;
  roles?: string | string[];
  roles_json?: string;
  metadata?: string | Record<string, string>;
  metadata_json?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  lastActiveAt?: string;
  last_active_at?: string;
  suspendedAt?: string;
  suspended_at?: string;
  suspendReason?: string;
  suspend_reason?: string;
};

type StoredIdentityRow = ListIdentityRow & {
  sponsorId?: string;
  sponsor_id?: string;
  sponsorChain?: string[] | string;
  sponsor_chain?: string[] | string;
  sponsor_chain_json?: string | string[];
  workspaceId?: string;
  workspace_id?: string;
  budget?: IdentityBudget | null;
  budget_json?: string | IdentityBudget | null;
  budgetUsage?: IdentityBudgetUsage | null;
  budget_usage?: string | IdentityBudgetUsage | null;
  budget_usage_json?: string | IdentityBudgetUsage | null;
};

type RoleRow = {
  id?: string;
  name?: string;
  description?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  orgId?: string;
  org_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  builtIn?: boolean | number;
  built_in?: boolean | number;
  createdAt?: string;
  created_at?: string;
};

type PolicyRow = {
  id?: string;
  name?: string;
  effect?: Policy["effect"];
  scopes?: string | string[];
  scopes_json?: string | string[];
  conditions?: string | Policy["conditions"];
  conditions_json?: string | Policy["conditions"];
  priority?: number | string;
  orgId?: string;
  org_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  createdAt?: string;
  created_at?: string;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

type AuditLogRow = {
  id?: string;
  action?: AuditAction;
  identity_id?: string;
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

type DashboardAuditCountRow = {
  action?: string | null;
  count?: number | string | null;
  tokensIssued?: number | string | null;
  tokensRevoked?: number | string | null;
  tokensRefreshed?: number | string | null;
  scopeChecks?: number | string | null;
  scopeDenials?: number | string | null;
};

type DashboardIdentityCountRow = {
  status?: string | null;
  count?: number | string | null;
  activeIdentities?: number | string | null;
  suspendedIdentities?: number | string | null;
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

type OrganizationRow = {
  id?: string;
  orgId?: string;
  org_id?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
};

type WorkspaceRow = {
  id?: string;
  workspaceId?: string;
  workspace_id?: string;
  orgId?: string;
  org_id?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  roles?: string | string[];
  roles_json?: string | string[];
};

const DUPLICATE_NAME_SQL = `
  SELECT id, name, org_id AS orgId
  FROM identities
  WHERE org_id = ? AND name = ?
  LIMIT 1
`;

const ORG_BUDGET_SQL = `
  SELECT budget, budget_json, default_budget, settings_json, data
  FROM org_budgets
  WHERE org_id = ?
  LIMIT 1
`;

const CHILD_IDENTITIES_SQL = `
  SELECT id, name, status, sponsor_id, created_at
  FROM identities
  WHERE org_id = ? AND sponsor_id = ?
  ORDER BY created_at DESC, id DESC
`;

const ACTIVE_TOKENS_SQL = `
  SELECT id, jti, token_id AS tokenId
  FROM tokens
  WHERE identity_id = ? AND status = 'active'
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

const SELECT_STORED_IDENTITY_COLUMNS = `
  SELECT
    id,
    name,
    type,
    org_id AS orgId,
    status,
    scopes,
    scopes_json,
    roles,
    roles_json,
    metadata,
    metadata_json,
    created_at AS createdAt,
    updated_at AS updatedAt,
    last_active_at AS lastActiveAt,
    suspended_at AS suspendedAt,
    suspend_reason AS suspendReason,
    sponsor_id AS sponsorId,
    sponsor_chain AS sponsorChain,
    sponsor_chain_json,
    workspace_id AS workspaceId,
    budget,
    budget_json,
    budget_usage AS budgetUsage,
    budget_usage_json
  FROM identities
`;

const SELECT_ROLE_COLUMNS = `
  SELECT
    id,
    name,
    description,
    scopes,
    scopes_json,
    org_id AS orgId,
    workspace_id AS workspaceId,
    built_in AS builtIn,
    created_at AS createdAt
  FROM roles
`;

const SELECT_POLICY_COLUMNS = `
  SELECT
    id,
    name,
    effect,
    scopes,
    scopes_json,
    conditions,
    conditions_json,
    priority,
    org_id AS orgId,
    workspace_id AS workspaceId,
    created_at AS createdAt,
    deleted_at AS deletedAt
  FROM policies
`;

const AUDIT_LOG_INSERT_SQL = `
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

const CREATE_AUDIT_WEBHOOKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_webhooks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const CREATE_AUDIT_WEBHOOKS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_audit_webhooks_org_created
  ON audit_webhooks (org_id, created_at DESC, id DESC)
`;

const SELECT_ORGANIZATION_SQL = `
  SELECT
    id,
    org_id AS orgId,
    scopes,
    scopes_json,
    roles,
    roles_json
  FROM organizations
  WHERE id = ?
  LIMIT 1
`;

const SELECT_WORKSPACE_SQL = `
  SELECT
    id,
    workspace_id AS workspaceId,
    org_id AS orgId,
    scopes,
    scopes_json,
    roles,
    roles_json
  FROM workspaces
  WHERE id = ?
  LIMIT 1
`;

export function createCloudflareStorage(bindings: CloudflareStorageBindings): AuthStorage {
  return createStorage({
    db: bindings.DB,
    identityNamespace: bindings.IDENTITY_DO,
    revocationKv: bindings.REVOCATION_KV,
    internalSecret: bindings.INTERNAL_SECRET,
  });
}

export function createDatabaseStorage(db: D1Database): AuthStorage {
  return createStorage({ db });
}

function createStorage(config: InternalStorageConfig): AuthStorage {
  const { db } = config;

  return {
    identities: {
      async list(orgId, options = {}) {
        const query = buildListIdentitiesQuery(orgId, options);
        const result = await db.prepare(query.sql).bind(...query.params).all<ListIdentityRow>();
        return (result.results ?? [])
          .map(hydrateListIdentity)
          .filter((identity): identity is AgentIdentity => identity !== null);
      },

      async get(id) {
        if (config.identityNamespace && config.internalSecret) {
          return fetchIdentityFromDurableObject(config, id);
        }

        const row = await db
          .prepare(`
            ${SELECT_STORED_IDENTITY_COLUMNS}
            WHERE id = ?
            LIMIT 1
          `)
          .bind(id.trim())
          .first<StoredIdentityRow>();

        return hydrateStoredIdentity(row);
      },

      async create(identity) {
        assertIdentityNamespace(config);
        const response = await requestIdentityDurableObject(config, identity.id, "/internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(identity),
        });
        return response.json<StoredIdentity>();
      },

      async update(id, patch) {
        assertIdentityNamespace(config);
        const response = await requestIdentityDurableObject(config, id, "/internal/update", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        return response.json<StoredIdentity>();
      },

      async delete(id) {
        assertIdentityNamespace(config);
        await requestIdentityDurableObject(config, id, "/internal/delete", {
          method: "DELETE",
        });
      },

      async suspend(id, reason) {
        assertIdentityNamespace(config);
        const response = await requestIdentityDurableObject(config, id, "/internal/suspend", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        return response.json<StoredIdentity>();
      },

      async retire(id, reason) {
        assertIdentityNamespace(config);
        const response = await requestIdentityDurableObject(config, id, "/internal/retire", {
          method: "POST",
          ...(reason
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason }),
              }
            : {}),
        });
        return response.json<StoredIdentity>();
      },

      async reactivate(id) {
        assertIdentityNamespace(config);
        const response = await requestIdentityDurableObject(config, id, "/internal/reactivate", {
          method: "POST",
        });
        return response.json<StoredIdentity>();
      },

      async findDuplicate(orgId, name) {
        const row = await db.prepare(DUPLICATE_NAME_SQL).bind(orgId, name).first<DuplicateIdentityRow>();
        const id = normalizeOptionalString(row?.id);
        const normalizedName = normalizeOptionalString(row?.name);
        const normalizedOrgId = normalizeOptionalString(row?.orgId) ?? normalizeOptionalString(row?.org_id);
        return id && normalizedName && normalizedOrgId
          ? { id, name: normalizedName, orgId: normalizedOrgId }
          : null;
      },

      async loadOrgBudget(orgId) {
        const row = await db.prepare(ORG_BUDGET_SQL).bind(orgId).first<OrgBudgetRow>();
        if (!row) {
          return undefined;
        }

        if (isIdentityBudget(row.budget)) {
          return row.budget;
        }

        if (isIdentityBudget(row.defaultBudget)) {
          return row.defaultBudget;
        }

        return (
          parseBudgetValue(row.budget_json) ??
          parseBudgetValue(row.default_budget) ??
          parseSettingsBudget(row.settings_json) ??
          parseBudgetValue(row.data)
        );
      },

      async listChildIds(orgId, sponsorId) {
        const result = await db.prepare(CHILD_IDENTITIES_SQL).bind(orgId, sponsorId).all<ChildIdentityRow>();
        return Array.from(
          new Set(
            (result.results ?? [])
              .map((row) => normalizeOptionalString(row.id) ?? "")
              .filter((id): id is string => id.length > 0 && id !== sponsorId),
          ),
        );
      },

      async listChildren(orgId, sponsorId) {
        const result = await db.prepare(CHILD_IDENTITIES_SQL).bind(orgId, sponsorId).all<ChildIdentityRow>();
        return (result.results ?? [])
          .map(hydrateChildIdentity)
          .filter((child): child is IdentityChildSummary => child !== null)
          .sort(compareChildIdentities);
      },

      async getStatusCounts(orgId) {
        const result = await db
          .prepare(`
            SELECT
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeIdentities,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspendedIdentities
            FROM identities
            WHERE org_id = ? AND status IN ('active', 'suspended')
          `)
          .bind(orgId)
          .all<DashboardIdentityCountRow>();

        return summarizeIdentityCounts(result.results ?? []);
      },
    },

    tokens: {
      async listActiveIds(identityId) {
        const result = await db.prepare(ACTIVE_TOKENS_SQL).bind(identityId).all<ActiveTokenRow>();
        return Array.from(
          new Set(
            (result.results ?? [])
              .map((row) => {
                const fromId = normalizeOptionalString(row.id);
                if (fromId) {
                  return fromId;
                }

                const fromJti = normalizeOptionalString(row.jti);
                if (fromJti) {
                  return fromJti;
                }

                const fromTokenId = normalizeOptionalString(row.tokenId) ?? normalizeOptionalString(row.token_id);
                return fromTokenId ?? "";
              })
              .filter((tokenId): tokenId is string => tokenId.length > 0),
          ),
        );
      },
    },

    revocations: {
      async revokeIdentityTokens(identityId, tokenIds, revokedAt) {
        assertRevocationKv(config);
        await Promise.all(
          tokenIds.map((tokenId) =>
            config.revocationKv!.put(
              `revoked:${tokenId}`,
              JSON.stringify({
                tokenId,
                identityId,
                revokedAt,
              }),
            ),
          ),
        );
      },
    },

    roles: {
      async create(role) {
        await db
          .prepare(`
            INSERT INTO roles (
              id,
              name,
              description,
              scopes,
              scopes_json,
              org_id,
              workspace_id,
              built_in,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            role.id,
            role.name,
            role.description,
            JSON.stringify(role.scopes),
            JSON.stringify(role.scopes),
            role.orgId,
            role.workspaceId ?? null,
            role.builtIn ? 1 : 0,
            role.createdAt,
          )
          .run();

        return role;
      },

      async get(id) {
        const normalizedId = normalizeOptionalString(id);
        if (!normalizedId) {
          return null;
        }

        const row = await db
          .prepare(`
            ${SELECT_ROLE_COLUMNS}
            WHERE id = ?
            LIMIT 1
          `)
          .bind(normalizedId)
          .first<RoleRow>();

        return hydrateRole(row);
      },

      async list(orgId, workspaceId) {
        const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required");
        const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
        const query = normalizedWorkspaceId
          ? {
              sql: `
                ${SELECT_ROLE_COLUMNS}
                WHERE org_id = ?
                  AND (workspace_id = ? OR workspace_id IS NULL)
                ORDER BY name ASC, id ASC
              `,
              params: [normalizedOrgId, normalizedWorkspaceId],
            }
          : {
              sql: `
                ${SELECT_ROLE_COLUMNS}
                WHERE org_id = ?
                ORDER BY name ASC, id ASC
              `,
              params: [normalizedOrgId],
            };

        const result = await db.prepare(query.sql).bind(...query.params).all<RoleRow>();
        return (result.results ?? [])
          .map(hydrateRole)
          .filter((role): role is Role => role !== null)
          .filter((role) =>
            role.orgId === normalizedOrgId
            && (normalizedWorkspaceId === undefined
              || role.workspaceId === undefined
              || role.workspaceId === normalizedWorkspaceId),
          );
      },

      async update(id, patch) {
        const current = await this.get(id);
        if (!current) {
          throw new StorageError("role_not_found", 404, "role_not_found");
        }

        const next: Role = {
          ...current,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
        };

        await db
          .prepare(`
            UPDATE roles
            SET name = ?, description = ?, scopes = ?, scopes_json = ?
            WHERE id = ? AND org_id = ?
          `)
          .bind(
            next.name,
            next.description,
            JSON.stringify(next.scopes),
            JSON.stringify(next.scopes),
            current.id,
            current.orgId,
          )
          .run();

        return next;
      },

      async delete(id) {
        const role = await this.get(id);
        if (!role) {
          throw new StorageError("role_not_found", 404, "role_not_found");
        }

        await db
          .prepare(`
            DELETE FROM roles
            WHERE id = ? AND org_id = ?
          `)
          .bind(role.id, role.orgId)
          .run();
      },

      async listByIds(roleIds) {
        const uniqueRoleIds = Array.from(
          new Set(
            roleIds
              .filter((roleId): roleId is string => typeof roleId === "string")
              .map((roleId) => roleId.trim())
              .filter(Boolean),
          ),
        );
        if (uniqueRoleIds.length === 0) {
          return [];
        }

        const placeholders = uniqueRoleIds.map(() => "?").join(", ");
        const result = await db
          .prepare(`
            ${SELECT_ROLE_COLUMNS}
            WHERE id IN (${placeholders})
          `)
          .bind(...uniqueRoleIds)
          .all<RoleRow>();

        return (result.results ?? [])
          .map(hydrateRole)
          .filter((role): role is Role => role !== null);
      },
    },

    policies: {
      async create(policy) {
        await db
          .prepare(`
            INSERT INTO policies (
              id,
              name,
              effect,
              scopes,
              scopes_json,
              conditions,
              conditions_json,
              priority,
              org_id,
              workspace_id,
              created_at,
              deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            policy.id,
            policy.name,
            policy.effect,
            JSON.stringify(policy.scopes),
            JSON.stringify(policy.scopes),
            JSON.stringify(policy.conditions),
            JSON.stringify(policy.conditions),
            policy.priority,
            policy.orgId,
            policy.workspaceId ?? null,
            policy.createdAt,
            null,
          )
          .run();

        return policy;
      },

      async get(id) {
        const normalizedId = normalizeOptionalString(id);
        if (!normalizedId) {
          return null;
        }

        const row = await db
          .prepare(`
            ${SELECT_POLICY_COLUMNS}
            WHERE id = ? AND deleted_at IS NULL
            LIMIT 1
          `)
          .bind(normalizedId)
          .first<PolicyRow>();

        return hydratePolicy(row);
      },

      async list(orgId, workspaceId) {
        const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required");
        const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
        const query = normalizedWorkspaceId
          ? {
              sql: `
                ${SELECT_POLICY_COLUMNS}
                WHERE org_id = ?
                  AND deleted_at IS NULL
                  AND (workspace_id = ? OR workspace_id IS NULL)
                ORDER BY priority DESC, id ASC
              `,
              params: [normalizedOrgId, normalizedWorkspaceId],
            }
          : {
              sql: `
                ${SELECT_POLICY_COLUMNS}
                WHERE org_id = ?
                  AND deleted_at IS NULL
                ORDER BY priority DESC, id ASC
              `,
              params: [normalizedOrgId],
            };

        const result = await db.prepare(query.sql).bind(...query.params).all<PolicyRow>();
        return (result.results ?? [])
          .map(hydratePolicy)
          .filter((policy): policy is Policy => policy !== null)
          .filter((policy) =>
            policy.orgId === normalizedOrgId
            && (normalizedWorkspaceId === undefined
              || policy.workspaceId === undefined
              || policy.workspaceId === normalizedWorkspaceId),
          );
      },

      async update(id, patch) {
        const current = await this.get(id);
        if (!current) {
          throw new StorageError("policy_not_found", 404, "policy_not_found");
        }

        const next: Policy = {
          ...current,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.effect !== undefined ? { effect: patch.effect } : {}),
          ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
          ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        };

        await db
          .prepare(`
            UPDATE policies
            SET name = ?, effect = ?, scopes = ?, scopes_json = ?, conditions = ?, conditions_json = ?, priority = ?
            WHERE id = ? AND org_id = ? AND deleted_at IS NULL
          `)
          .bind(
            next.name,
            next.effect,
            JSON.stringify(next.scopes),
            JSON.stringify(next.scopes),
            JSON.stringify(next.conditions),
            JSON.stringify(next.conditions),
            next.priority,
            current.id,
            current.orgId,
          )
          .run();

        return next;
      },

      async delete(id) {
        const policy = await this.get(id);
        if (!policy) {
          throw new StorageError("policy_not_found", 404, "policy_not_found");
        }

        await db
          .prepare(`
            UPDATE policies
            SET deleted_at = ?
            WHERE id = ? AND org_id = ? AND deleted_at IS NULL
          `)
          .bind(new Date().toISOString(), policy.id, policy.orgId)
          .run();
      },
    },

    audit: {
      async write(entry) {
        await db.prepare(AUDIT_LOG_INSERT_SQL).bind(...toAuditInsertParams(entry)).run();
      },

      async writeBatch(entries) {
        if (entries.length === 0) {
          return;
        }

        const statements = entries.map((entry) =>
          db.prepare(AUDIT_LOG_INSERT_SQL).bind(...toAuditInsertParams(entry)),
        );
        await db.batch(statements);
      },

      async query(query, options = {}) {
        const built = buildAuditQuery(query, options);
        const result = await db.prepare(built.sql).bind(...built.params).all<AuditLogRow>();
        return (result.results ?? [])
          .map(toAuditEntryRecord)
          .filter((entry): entry is AuditEntryRecord => entry !== null);
      },

      async getActionCounts(orgId, query) {
        const built = buildAuditCountsQuery(orgId, query);
        const result = await db.prepare(built.sql).bind(...built.params).all<DashboardAuditCountRow>();
        return summarizeAuditCounts(result.results ?? []);
      },

      async writeIdentitySuspendedEvent(identity, reason, actorId) {
        const payload = JSON.stringify({
          eventType: "identity.suspended",
          status: identity.status,
          sponsorId: identity.sponsorId,
          sponsorChain: identity.sponsorChain,
          actorId,
          reason,
        });

        try {
          await db.prepare(INSERT_AUDIT_EVENT_SQL)
            .bind(
              crypto.randomUUID(),
              identity.orgId,
              identity.workspaceId,
              identity.id,
              "identity.suspended",
              reason,
              payload,
              identity.updatedAt,
            )
            .run();
        } catch (error) {
          console.error("Failed to write identity suspended audit event", error);
        }
      },
    },

    auditWebhooks: {
      async create(input) {
        await ensureAuditWebhookTable(db);
        const timestamp = new Date().toISOString();
        const record: AuditWebhookRecord = {
          id: `awh_${crypto.randomUUID()}`,
          orgId: input.orgId,
          url: input.url,
          secret: input.secret,
          events: input.events ?? [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        await db
          .prepare(`
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
          `)
          .bind(
            record.id,
            record.orgId,
            record.url,
            record.secret,
            record.events ? JSON.stringify(record.events) : null,
            record.createdAt,
            record.updatedAt,
          )
          .run();

        return record;
      },

      async list(orgId) {
        await ensureAuditWebhookTable(db);
        const result = await db
          .prepare(`
            SELECT id, org_id, url, secret, events_json, created_at, updated_at
            FROM audit_webhooks
            WHERE org_id = ?
            ORDER BY created_at DESC, id DESC
          `)
          .bind(orgId)
          .all<AuditWebhookRow>();

        return (result.results ?? [])
          .map(toAuditWebhookRecord)
          .filter((record): record is AuditWebhookRecord => record !== null);
      },

      async delete(orgId, id) {
        await ensureAuditWebhookTable(db);
        await db
          .prepare(`
            DELETE FROM audit_webhooks
            WHERE org_id = ? AND id = ?
          `)
          .bind(orgId, id)
          .run();
      },
    },

    contexts: createContextStorage(db),
  };
}

function createContextStorage(db: D1Database): ContextStorage {
  return {
    async getOrganization(orgId) {
      const row = await db.prepare(SELECT_ORGANIZATION_SQL).bind(orgId.trim()).first<OrganizationRow>();
      return hydrateOrganizationContext(row);
    },

    async getWorkspace(workspaceId) {
      const row = await db.prepare(SELECT_WORKSPACE_SQL).bind(workspaceId.trim()).first<WorkspaceRow>();
      return hydrateWorkspaceContext(row);
    },
  };
}

async function fetchIdentityFromDurableObject(
  config: InternalStorageConfig,
  identityId: string,
): Promise<StoredIdentity | null> {
  try {
    const response = await requestIdentityDurableObject(config, identityId, "/internal/get", {
      method: "GET",
    });
    return response.json<StoredIdentity>();
  } catch (error) {
    if (error instanceof StorageError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function requestIdentityDurableObject(
  config: InternalStorageConfig,
  identityId: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  assertIdentityNamespace(config);
  const durableObjectId = config.identityNamespace!.idFromName(identityId);
  const durableObject = config.identityNamespace!.get(durableObjectId);
  const headers = new Headers(init.headers);
  headers.set("x-internal-secret", config.internalSecret ?? "");
  const response = await durableObject.fetch(
    new Request(`http://identity-do${path}`, {
      ...init,
      headers,
    }),
  );

  if (response.ok) {
    return response;
  }

  const message = await readResponseError(response, "Identity storage request failed");
  throw new StorageError(message, response.status, "identity_storage_error");
}

function assertIdentityNamespace(config: InternalStorageConfig): void {
  if (!config.identityNamespace || !config.internalSecret) {
    throw new StorageError("identity storage is not available in this runtime", 500, "identity_storage_unavailable");
  }
}

function assertRevocationKv(config: InternalStorageConfig): void {
  if (!config.revocationKv) {
    throw new StorageError("revocation storage is not available in this runtime", 500, "revocation_storage_unavailable");
  }
}

function buildListIdentitiesQuery(
  orgId: string,
  options: ListIdentitiesOptions,
): { sql: string; params: Array<string | number> } {
  const clauses = ["org_id = ?"];
  const params: Array<string | number> = [orgId];

  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }

  if (options.type) {
    clauses.push("type = ?");
    params.push(options.type);
  }

  if (options.cursorId) {
    clauses.push("(created_at, id) < (SELECT created_at, id FROM identities WHERE id = ?)");
    params.push(options.cursorId);
  }

  params.push(options.limit ?? 50);

  return {
    sql: `
      SELECT *
      FROM identities
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    params,
  };
}

function hydrateListIdentity(row: ListIdentityRow | null): AgentIdentity | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  const updatedAt = normalizeOptionalString(row.updatedAt) ?? normalizeOptionalString(row.updated_at);
  if (!id || !name || !orgId || !createdAt || !updatedAt) {
    return null;
  }

  const status = normalizeIdentityStatus(row.status) ?? "active";
  const type = normalizeIdentityType(row.type);
  if (!type) {
    return null;
  }

  return {
    id,
    name,
    type,
    orgId,
    status,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
    metadata: parseRecordColumn(row.metadata_json ?? row.metadata),
    createdAt,
    updatedAt,
    ...(normalizeOptionalString(row.lastActiveAt) ?? normalizeOptionalString(row.last_active_at)
      ? { lastActiveAt: normalizeOptionalString(row.lastActiveAt) ?? normalizeOptionalString(row.last_active_at)! }
      : {}),
    ...(normalizeOptionalString(row.suspendedAt) ?? normalizeOptionalString(row.suspended_at)
      ? { suspendedAt: normalizeOptionalString(row.suspendedAt) ?? normalizeOptionalString(row.suspended_at)! }
      : {}),
    ...(normalizeOptionalString(row.suspendReason) ?? normalizeOptionalString(row.suspend_reason)
      ? { suspendReason: normalizeOptionalString(row.suspendReason) ?? normalizeOptionalString(row.suspend_reason)! }
      : {}),
  };
}

function hydrateStoredIdentity(row: StoredIdentityRow | null): StoredIdentity | null {
  if (!row) {
    return null;
  }

  const identity = hydrateListIdentity(row);
  const sponsorId = normalizeOptionalString(row.sponsorId) ?? normalizeOptionalString(row.sponsor_id);
  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  if (!identity || !sponsorId || !workspaceId) {
    return null;
  }

  const sponsorChain = parseStringArrayColumn(
    row.sponsor_chain_json ?? row.sponsorChain ?? row.sponsor_chain,
  );
  const budget = parseBudgetColumn(row.budget_json ?? row.budget);
  const budgetUsage = parseBudgetUsageColumn(
    row.budget_usage_json ?? row.budgetUsage ?? row.budget_usage,
  );

  return {
    ...identity,
    sponsorId,
    sponsorChain: sponsorChain.length > 0 ? sponsorChain : [sponsorId, identity.id],
    workspaceId,
    ...(budget ? { budget } : {}),
    ...(budgetUsage ? { budgetUsage } : {}),
  };
}

function hydrateChildIdentity(row: ChildIdentityRow | null): IdentityChildSummary | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    status: normalizeIdentityStatus(row.status) ?? "active",
    ...(normalizeOptionalString(row.sponsorId) ?? normalizeOptionalString(row.sponsor_id)
      ? { sponsorId: normalizeOptionalString(row.sponsorId) ?? normalizeOptionalString(row.sponsor_id)! }
      : {}),
    ...(normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at)
      ? { createdAt: normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at)! }
      : {}),
  };
}

function compareChildIdentities(left: IdentityChildSummary, right: IdentityChildSummary): number {
  const leftCreatedAt = left.createdAt ?? "";
  const rightCreatedAt = right.createdAt ?? "";
  return rightCreatedAt.localeCompare(leftCreatedAt) || right.id.localeCompare(left.id);
}

function normalizeIdentityStatus(status: unknown): IdentityStatus | undefined {
  return status === "active" || status === "suspended" || status === "retired" ? status : undefined;
}

function normalizeIdentityType(type: unknown): IdentityType | undefined {
  return type === "agent" || type === "human" || type === "service" ? type : undefined;
}

function hydrateRole(row: RoleRow | null): Role | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const description = normalizeOptionalString(row.description);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  if (!id || !name || !description || !orgId || !createdAt) {
    return null;
  }

  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const builtIn = row.builtIn === true || row.builtIn === 1 || row.built_in === true || row.built_in === 1;

  return {
    id,
    name,
    description,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    builtIn,
    createdAt,
  };
}

function hydratePolicy(row: PolicyRow | null): Policy | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const effect = row.effect;
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  const deletedAt = normalizeOptionalString(row.deletedAt) ?? normalizeOptionalString(row.deleted_at);
  if (!id || !name || !effect || !orgId || !createdAt || deletedAt) {
    return null;
  }

  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const priority = typeof row.priority === "number" ? row.priority : Number(row.priority);
  if (!Number.isInteger(priority)) {
    return null;
  }

  return {
    id,
    name,
    effect,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    conditions: parseConditionsColumn(row.conditions_json ?? row.conditions),
    priority,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt,
  };
}

function toAuditInsertParams(entry: AuditLogWriteEntry): unknown[] {
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

function buildAuditQuery(
  params: AuditQueryInput,
  options: AuditQueryOptions = {},
): { sql: string; params: unknown[] } {
  const clauses = ["org_id = ?"];
  const values: unknown[] = [params.orgId];

  if (params.identityId) {
    clauses.push("identity_id = ?");
    values.push(params.identityId);
  }

  if (params.action) {
    clauses.push("action = ?");
    values.push(params.action);
  }

  if (params.workspaceId) {
    clauses.push("workspace_id = ?");
    values.push(params.workspaceId);
  }

  if (params.plane) {
    clauses.push("plane = ?");
    values.push(params.plane);
  }

  if (params.result) {
    clauses.push("result = ?");
    values.push(params.result);
  }

  if (params.from) {
    clauses.push("timestamp >= ?");
    values.push(params.from);
  }

  if (params.to) {
    clauses.push("(timestamp < ?)");
    values.push(params.to);
  }

  if (params.cursor) {
    clauses.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
    values.push(params.cursor.timestamp, params.cursor.timestamp, params.cursor.id);
  }

  values.push(params.limit + (options.includeOverflowRow ?? true ? 1 : 0));

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
    params: values,
  };
}

function toAuditEntryRecord(row: AuditLogRow | null): AuditEntryRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const action = row.action;
  const identityId = normalizeOptionalString(row.identity_id);
  const orgId = normalizeOptionalString(row.org_id);
  const timestamp = normalizeOptionalString(row.timestamp);
  const result = row.result;
  if (!id || !action || !identityId || !orgId || !timestamp || !result) {
    return null;
  }

  return {
    id,
    action,
    identityId,
    orgId,
    ...(normalizeOptionalString(row.workspace_id) ? { workspaceId: normalizeOptionalString(row.workspace_id)! } : {}),
    ...(normalizeOptionalString(row.plane) ? { plane: normalizeOptionalString(row.plane)! } : {}),
    ...(normalizeOptionalString(row.resource) ? { resource: normalizeOptionalString(row.resource)! } : {}),
    result,
    ...(parseNullableRecordColumn(row.metadata_json) ? { metadata: parseNullableRecordColumn(row.metadata_json)! } : {}),
    ...(normalizeOptionalString(row.ip) ? { ip: normalizeOptionalString(row.ip)! } : {}),
    ...(normalizeOptionalString(row.user_agent) ? { userAgent: normalizeOptionalString(row.user_agent)! } : {}),
    timestamp,
    ...(normalizeOptionalString(row.created_at) ? { createdAt: normalizeOptionalString(row.created_at)! } : {}),
  };
}

function buildAuditCountsQuery(
  orgId: string,
  query: DashboardAuditQuery,
): { sql: string; params: unknown[] } {
  const clauses = [
    "org_id = ?",
    "(",
    "action IN ('token.issued', 'token.refreshed', 'token.revoked', 'scope.denied')",
    "OR (action = 'scope.checked' AND result IN ('allowed', 'denied'))",
    ")",
  ];
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
      SELECT action, COUNT(*) AS count
      FROM audit_logs
      WHERE ${clauses.join(" AND ")}
      GROUP BY action
    `,
    params,
  };
}

function summarizeAuditCounts(rows: DashboardAuditCountRow[]): DashboardAuditCounts {
  const counts: DashboardAuditCounts = {
    tokensIssued: 0,
    tokensRevoked: 0,
    tokensRefreshed: 0,
    scopeChecks: 0,
    scopeDenials: 0,
  };

  for (const row of rows) {
    if (hasAggregateAuditShape(row)) {
      counts.tokensIssued += toCount(row.tokensIssued);
      counts.tokensRevoked += toCount(row.tokensRevoked);
      counts.tokensRefreshed += toCount(row.tokensRefreshed);
      counts.scopeChecks += toCount(row.scopeChecks);
      counts.scopeDenials += toCount(row.scopeDenials);
      continue;
    }

    const action = normalizeOptionalString(row.action);
    if (!action) {
      continue;
    }

    const count = toCount(row.count);
    if (action === "token.issued") {
      counts.tokensIssued += count;
    } else if (action === "token.revoked") {
      counts.tokensRevoked += count;
    } else if (action === "token.refreshed") {
      counts.tokensRefreshed += count;
    } else if (action === "scope.checked") {
      counts.scopeChecks += count;
    } else if (action === "scope.denied") {
      counts.scopeDenials += count;
    }
  }

  return counts;
}

function summarizeIdentityCounts(rows: DashboardIdentityCountRow[]): IdentityStatusCounts {
  const counts: IdentityStatusCounts = {
    activeIdentities: 0,
    suspendedIdentities: 0,
  };

  for (const row of rows) {
    if (row.activeIdentities !== undefined || row.suspendedIdentities !== undefined) {
      counts.activeIdentities += toCount(row.activeIdentities);
      counts.suspendedIdentities += toCount(row.suspendedIdentities);
      continue;
    }

    const status = normalizeOptionalString(row.status);
    const count = toCount(row.count);
    if (status === "active") {
      counts.activeIdentities += count;
    } else if (status === "suspended") {
      counts.suspendedIdentities += count;
    }
  }

  return counts;
}

function hasAggregateAuditShape(row: DashboardAuditCountRow): boolean {
  return row.tokensIssued !== undefined
    || row.tokensRevoked !== undefined
    || row.tokensRefreshed !== undefined
    || row.scopeChecks !== undefined
    || row.scopeDenials !== undefined;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

async function ensureAuditWebhookTable(db: D1Database): Promise<void> {
  await db.exec(CREATE_AUDIT_WEBHOOKS_TABLE_SQL);
  await db.exec(CREATE_AUDIT_WEBHOOKS_INDEX_SQL);
}

function toAuditWebhookRecord(row: AuditWebhookRow | null): AuditWebhookRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const orgId = normalizeOptionalString(row.org_id);
  const url = normalizeOptionalString(row.url);
  const secret = normalizeOptionalString(row.secret);
  if (!id || !orgId || !url || !secret) {
    return null;
  }

  const events = parseStoredEvents(row.events_json);
  return {
    id,
    orgId,
    url,
    secret,
    events: events ?? [],
    ...(normalizeOptionalString(row.created_at) ? { createdAt: normalizeOptionalString(row.created_at)! } : {}),
    ...(normalizeOptionalString(row.updated_at) ? { updatedAt: normalizeOptionalString(row.updated_at)! } : {}),
  };
}

function hydrateOrganizationContext(row: OrganizationRow | null): OrganizationContextRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  if (!id || !orgId) {
    return null;
  }

  return {
    id,
    orgId,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
  };
}

function hydrateWorkspaceContext(row: WorkspaceRow | null): WorkspaceContextRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  if (!id || !workspaceId || !orgId) {
    return null;
  }

  return {
    id,
    workspaceId,
    orgId,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    roles: parseStringArrayColumn(row.roles_json ?? row.roles),
  };
}

function parseStringArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseConditionsColumn(value: unknown): Policy["conditions"] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Policy["conditions"][number] =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseConditionsColumn(parsed);
  } catch {
    return [];
  }
}

function parseRecordColumn(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseRecordColumn(parsed);
  } catch {
    return {};
  }
}

function parseNullableRecordColumn(value: unknown): Record<string, string> | undefined {
  const parsed = parseRecordColumn(value);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseBudgetValue(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isIdentityBudget(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseSettingsBudget(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { budget?: unknown };
    return isIdentityBudget(parsed.budget) ? parsed.budget : undefined;
  } catch {
    return undefined;
  }
}

function parseBudgetColumn(value: unknown): IdentityBudget | undefined {
  if (isIdentityBudget(value)) {
    return value;
  }

  return typeof value === "string" ? parseBudgetValue(value) : undefined;
}

function parseBudgetUsageColumn(value: unknown): IdentityBudgetUsage | undefined {
  if (isIdentityBudgetUsage(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isIdentityBudgetUsage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isIdentityBudget(value: unknown): value is IdentityBudget {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIdentityBudgetUsage(value: unknown): value is IdentityBudgetUsage {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStoredEvents(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseStoredEvents(parsed);
  } catch {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new StorageError(message, 400, "invalid_storage_input");
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function readResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.clone().json<{ error?: unknown }>();
    if (typeof body?.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall back to text.
  }

  const text = await response.text().catch(() => "");
  return text || fallback;
}
