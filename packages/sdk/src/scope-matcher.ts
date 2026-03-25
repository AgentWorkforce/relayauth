import type { Action, ParsedScope } from "@relayauth/types";

import { RelayAuthError } from "./errors.js";
import { parseScope, parseScopes } from "./scope-parser.js";

const MANAGE_IMPLIES = new Set<Action>(["read", "write", "create", "delete"]);

function matchAction(requested: Action, granted: Action): boolean {
  if (granted === "*" || granted === requested) {
    return true;
  }

  return granted === "manage" && MANAGE_IMPLIES.has(requested);
}

function matchPath(requested: ParsedScope, granted: ParsedScope): boolean {
  if (granted.path === "*" || granted.path === requested.path) {
    return true;
  }

  if (requested.plane !== "relayfile" || requested.resource !== "fs") {
    return false;
  }

  if (!granted.path.endsWith("/*")) {
    return false;
  }

  const prefix = granted.path.slice(0, -1);
  return requested.path.startsWith(prefix);
}

export function matchParsedScope(
  requested: ParsedScope,
  granted: ParsedScope,
): boolean {
  if (granted.plane !== "*" && granted.plane !== requested.plane) {
    return false;
  }

  if (granted.resource !== "*" && granted.resource !== requested.resource) {
    return false;
  }

  if (!matchAction(requested.action, granted.action)) {
    return false;
  }

  return matchPath(requested, granted);
}

export function matchScope(requested: string, granted: string[]): boolean {
  if (granted.length === 0) {
    return false;
  }

  const parsedRequested = parseScope(requested);
  const parsedGranted = parseScopes(granted);

  return parsedGranted.some((scope) => matchParsedScope(parsedRequested, scope));
}

export function matchesAny(
  requested: string[],
  granted: string[],
): { matched: string[]; denied: string[] } {
  const parsedGranted = parseScopes(granted);
  const matched: string[] = [];
  const denied: string[] = [];

  for (const raw of requested) {
    const parsedRequested = parseScope(raw);

    if (parsedGranted.some((scope) => matchParsedScope(parsedRequested, scope))) {
      matched.push(raw);
      continue;
    }

    denied.push(raw);
  }

  return { matched, denied };
}

function scopeEscalationError(scope: string): RelayAuthError {
  return new RelayAuthError(
    `Requested scope "${scope}" is broader than the parent scope set`,
    "scope_escalation",
    403,
  );
}

export function validateSubset(
  parentScopes: string[],
  requestedScopes: string[],
): string[] {
  const parentParsed = parseScopes(parentScopes);
  const narrowed: string[] = [];

  for (const raw of requestedScopes) {
    const requested = parseScope(raw);
    const allowed = parentParsed.some((parent) =>
      matchParsedScope(requested, parent),
    );

    if (!allowed) {
      throw scopeEscalationError(raw);
    }

    narrowed.push(raw);
  }

  return narrowed;
}

export function isSubsetOf(scopes: string[], parents: string[]): boolean {
  const parsedScopes = parseScopes(scopes);
  const parsedParents = parseScopes(parents);

  return parsedScopes.every((scope) =>
    parsedParents.some((parent) => matchParsedScope(scope, parent)),
  );
}
