export type IdentityStatus = "active" | "suspended" | "retired";

export type IdentityType = "agent" | "human" | "service";

export interface AgentIdentity {
  id: string;
  name: string;
  type: IdentityType;
  orgId: string;
  status: IdentityStatus;
  scopes: string[];
  roles: string[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  suspendedAt?: string;
  suspendReason?: string;
}

export interface CreateIdentityInput {
  name: string;
  type?: IdentityType;
  scopes?: string[];
  roles?: string[];
  metadata?: Record<string, string>;
  workspaceId?: string;
}
