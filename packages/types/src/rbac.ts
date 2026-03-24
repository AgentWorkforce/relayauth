export interface Role {
  id: string;
  name: string;
  description: string;
  scopes: string[];
  orgId: string;
  workspaceId?: string;
  builtIn: boolean;
  createdAt: string;
}

export type PolicyEffect = "allow" | "deny";

export type PolicyConditionType = "time" | "ip" | "identity" | "workspace";

export interface PolicyCondition {
  type: PolicyConditionType;
  operator: "eq" | "neq" | "in" | "not_in" | "gt" | "lt" | "matches";
  value: string | string[];
}

export interface Policy {
  id: string;
  name: string;
  effect: PolicyEffect;
  scopes: string[];
  conditions: PolicyCondition[];
  priority: number;
  orgId: string;
  workspaceId?: string;
  createdAt: string;
}
