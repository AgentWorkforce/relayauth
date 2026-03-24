export type AuditAction =
  | "token.issued"
  | "token.refreshed"
  | "token.revoked"
  | "token.validated"
  | "identity.created"
  | "identity.updated"
  | "identity.suspended"
  | "identity.retired"
  | "scope.checked"
  | "scope.denied"
  | "role.assigned"
  | "role.removed"
  | "policy.created"
  | "policy.updated"
  | "policy.deleted"
  | "key.rotated";

export interface AuditEntry {
  id: string;
  action: AuditAction;
  identityId: string;
  orgId: string;
  workspaceId?: string;
  plane?: string;
  resource?: string;
  result: "allowed" | "denied" | "error";
  metadata?: Record<string, string>;
  ip?: string;
  userAgent?: string;
  timestamp: string;
}

export interface AuditQuery {
  identityId?: string;
  action?: AuditAction;
  orgId?: string;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
