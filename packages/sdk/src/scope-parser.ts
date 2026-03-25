import type { Action, ParsedScope, Plane } from "@relayauth/types";

import { InvalidScopeError } from "./errors.js";

const PLANES = ["relaycast", "relayfile", "cloud", "relayauth"] as const;
const ACTIONS = [
  "read",
  "write",
  "create",
  "delete",
  "manage",
  "run",
  "send",
  "invoke",
  "*",
] as const;
const MANAGE_IMPLIES = new Set<Action>(["read", "write", "create", "delete"]);
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function isPlane(value: string): value is Plane {
  return (PLANES as readonly string[]).includes(value);
}

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

function invalidScope(raw: string, reason: string): never {
  throw new InvalidScopeError(raw, reason);
}

function normalizeFsPath(raw: string, path: string): string {
  if (path === "*") {
    return path;
  }

  if (!path.startsWith("/")) {
    invalidScope(raw, "filesystem paths must start with /");
  }

  if (path.includes("\\")) {
    invalidScope(raw, "filesystem paths must use POSIX separators");
  }

  if (path.includes("**")) {
    invalidScope(raw, "filesystem paths must not contain **");
  }

  const wildcardIndex = path.indexOf("*");
  if (wildcardIndex !== -1 && !path.endsWith("/*")) {
    invalidScope(raw, "filesystem paths only support a trailing /* wildcard");
  }

  if (path.endsWith("/*") && path.slice(0, -2).includes("*")) {
    invalidScope(raw, "filesystem paths only support a trailing /* wildcard");
  }

  const normalized = path.replace(/\/+/g, "/");
  const segments = normalized.split("/");

  if (segments.includes("..")) {
    invalidScope(raw, "filesystem paths must not contain ..");
  }

  if (normalized.endsWith("/*")) {
    const base = normalized.slice(0, -2);
    return `${base === "" ? "/" : base}/*`;
  }

  return normalized;
}

function validateSegments(raw: string, parts: string[]): ParsedScope {
  const [plane, resource, action, path = "*"] = parts;

  if (!isPlane(plane) && plane !== "*") {
    invalidScope(raw, "unknown plane");
  }

  if (resource !== "*" && !IDENTIFIER_PATTERN.test(resource)) {
    invalidScope(raw, "invalid resource");
  }

  if (!isAction(action)) {
    invalidScope(raw, "invalid action");
  }

  if (path.length === 0) {
    invalidScope(raw, "path must not be empty");
  }

  const normalizedPath =
    plane === "relayfile" && resource === "fs"
      ? normalizeFsPath(raw, path)
      : path;

  return {
    plane,
    resource,
    action,
    path: normalizedPath,
    raw,
  };
}

export function parseScope(raw: string): ParsedScope {
  if (raw.length === 0) {
    invalidScope(raw, "scope must not be empty");
  }

  if (raw.trim() !== raw) {
    invalidScope(raw, "scope must not have leading or trailing whitespace");
  }

  if (/\s/.test(raw)) {
    invalidScope(raw, "scope must not contain whitespace");
  }

  if (raw.includes("**")) {
    invalidScope(raw, "scope must not contain **");
  }

  const parts = raw.split(":");
  if (parts.length !== 3 && parts.length !== 4) {
    invalidScope(raw, "scope must have 3 or 4 segments");
  }

  if (parts.some((part) => part.length === 0)) {
    invalidScope(raw, "scope segments must not be empty");
  }

  return validateSegments(raw, parts);
}

export function validateScope(raw: string): boolean {
  try {
    parseScope(raw);
    return true;
  } catch (error) {
    if (error instanceof InvalidScopeError) {
      return false;
    }

    throw error;
  }
}

export function parseScopes(
  raws: string[],
  opts?: { strict?: boolean },
): ParsedScope[] {
  const strict = opts?.strict ?? true;
  const parsed: ParsedScope[] = [];

  for (const raw of raws) {
    try {
      parsed.push(parseScope(raw));
    } catch (error) {
      if (!strict && error instanceof InvalidScopeError) {
        continue;
      }

      throw error;
    }
  }

  return parsed;
}

function matchAction(granted: Action, requested: Action): boolean {
  if (granted === "*" || granted === requested) {
    return true;
  }

  return granted === "manage" && MANAGE_IMPLIES.has(requested);
}

function matchFsPath(granted: string, requested: string): boolean {
  if (granted === "*" || granted === requested) {
    return true;
  }

  if (!granted.endsWith("/*")) {
    return false;
  }

  const prefix = granted.slice(0, -1);
  return requested.startsWith(prefix);
}

function matches(granted: ParsedScope, requested: ParsedScope): boolean {
  if (granted.plane !== "*" && granted.plane !== requested.plane) {
    return false;
  }

  if (granted.resource !== "*" && granted.resource !== requested.resource) {
    return false;
  }

  if (!matchAction(granted.action, requested.action)) {
    return false;
  }

  if (requested.plane === "relayfile" && requested.resource === "fs") {
    return matchFsPath(granted.path, requested.path);
  }

  return granted.path === "*" || granted.path === requested.path;
}

export function isSubsetOf(scopes: string[], parents: string[]): boolean {
  const parsedScopes = parseScopes(scopes);
  const parsedParents = parseScopes(parents);

  return parsedScopes.every((scope) =>
    parsedParents.some((parent) => matches(parent, scope)),
  );
}
