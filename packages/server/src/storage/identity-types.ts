import type { AgentIdentity, IdentityStatus, IdentityType } from "@relayauth/types";

export type { AgentIdentity, IdentityStatus, IdentityType };

export interface IdentityBudget {
  maxActionsPerHour?: number;
  maxCostPerDay?: number;
  alertThreshold?: number;
  autoSuspend?: boolean;
}

export interface IdentityBudgetUsage {
  actionsThisHour: number;
  costToday: number;
  lastResetAt: string;
}

export interface StoredIdentity extends AgentIdentity {
  sponsorId: string;
  sponsorChain: string[];
  workspaceId: string;
  budget?: IdentityBudget;
  budgetUsage?: IdentityBudgetUsage;
}
