export type Plane = "relaycast" | "relayfile" | "cloud" | "relayauth";

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
} as const satisfies Record<string, ScopeTemplate>;
