export type Plane = "relaycast" | "relayfile" | "cloud" | "relayauth" | "*";

export type Action =
  | "read"
  | "write"
  | "create"
  | "delete"
  | "manage"
  | "run"
  | "send"
  | "invoke"
  | "*";

export interface ParsedScope {
  plane: Plane;
  resource: string;
  action: Action;
  path: string;
  raw: string;
}

export interface ScopeTemplate {
  name: string;
  description: string;
  scopes: string[];
}

export const SCOPE_TEMPLATES = {
  "relaycast:full": {
    name: "Relaycast Full Access",
    description: "Full read/write access to all relaycast resources",
    scopes: ["relaycast:*:*:*"],
  },
  "relayfile:read-only": {
    name: "Relayfile Read Only",
    description: "Read-only access to relayfile",
    scopes: ["relayfile:fs:read:*"],
  },
  "relayfile:full": {
    name: "Relayfile Full Access",
    description: "Full access to relayfile resources",
    scopes: ["relayfile:*:*:*"],
  },
  "cloud:full": {
    name: "Cloud Full Access",
    description: "Full access to cloud resources",
    scopes: ["cloud:*:*:*"],
  },
  "cloud:workflow-runner": {
    name: "Cloud Workflow Runner",
    description: "Read and run workflow capabilities",
    scopes: ["cloud:workflow:read:*", "cloud:workflow:run:*"],
  },
  "relayauth:scope-reader": {
    name: "RelayAuth Scope Reader",
    description: "Read scope definitions and templates",
    scopes: ["relayauth:scope:read:*"],
  },
  "relayauth:token-manager": {
    name: "RelayAuth Token Manager",
    description: "Create, read, and manage tokens",
    scopes: ["relayauth:token:create:*", "relayauth:token:read:*", "relayauth:token:manage:*"],
  },
  "relayauth:identity-manager": {
    name: "RelayAuth Identity Manager",
    description: "Manage identities",
    scopes: ["relayauth:identity:read:*", "relayauth:identity:manage:*"],
  },
  "relayauth:admin": {
    name: "RelayAuth Admin",
    description: "Broad relayauth administrative access",
    scopes: ["relayauth:*:manage:*", "relayauth:*:read:*"],
  },
  "read-all": {
    name: "Cross-Plane Read Only",
    description: "Read-only access across built-in planes",
    scopes: ["relaycast:*:read:*", "relayfile:*:read:*", "cloud:*:read:*", "relayauth:*:read:*"],
  },
} as const satisfies Record<string, ScopeTemplate>;
