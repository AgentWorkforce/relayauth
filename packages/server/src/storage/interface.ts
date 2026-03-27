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
} from "../durable-objects/identity-do.js";

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

export type AuditQueryInput = {
  orgId: string;
  identityId?: string;
  action?: AuditAction;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  cursor?: {
    timestamp: string;
    id: string;
  };
  limit: number;
};

export type AuditQueryOptions = {
  includeOverflowRow?: boolean;
};

export type DashboardAuditQuery = {
  from?: string;
  to?: string;
};

export type DashboardAuditCounts = {
  tokensIssued: number;
  tokensRevoked: number;
  tokensRefreshed: number;
  scopeChecks: number;
  scopeDenials: number;
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
  listActiveIds(identityId: string): Promise<string[]>;
}

export interface RevocationStorage {
  revokeIdentityTokens(identityId: string, tokenIds: string[], revokedAt: string): Promise<void>;
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
  query(query: AuditQueryInput, options?: AuditQueryOptions): Promise<AuditEntryRecord[]>;
  getActionCounts(orgId: string, query: DashboardAuditQuery): Promise<DashboardAuditCounts>;
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

export interface AuthStorage {
  identities: IdentityStorage;
  tokens: TokenStorage;
  revocations: RevocationStorage;
  roles: RoleStorage;
  policies: PolicyStorage;
  audit: AuditStorage;
  auditWebhooks: AuditWebhookStorage;
  contexts: ContextStorage;
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

export type { IdentityBudget, IdentityBudgetUsage, StoredIdentity, PolicyCondition, PolicyEffect };
