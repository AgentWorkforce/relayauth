/**
 * ACL permission resolution and enforcement.
 *
 * Ported from relayfile/packages/core/src/acl.ts.
 * Provides file-level permission checks using a minimal storage adapter interface.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIRECTORY_PERMISSION_MARKER = ".relayfile.acl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenClaims {
  workspaceId: string;
  agentName: string;
  scopes: Set<string>;
}

export interface ParsedPermissionRule {
  effect: "allow" | "deny";
  kind: "scope" | "agent" | "workspace" | "public";
  value: string;
}

/** Minimal storage interface for ACL resolution. */
export interface AclStorageAdapter {
  getFile(path: string): { semantics: { permissions?: string[] } } | undefined;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function parsePermissionRule(raw: string): ParsedPermissionRule | null {
  let rule = raw.trim();
  if (!rule) {
    return null;
  }

  let effect: ParsedPermissionRule["effect"] = "allow";
  const lower = rule.toLowerCase();
  if (lower.startsWith("allow:")) {
    rule = rule.slice("allow:".length).trim();
  } else if (lower.startsWith("deny:")) {
    effect = "deny";
    rule = rule.slice("deny:".length).trim();
  }

  const normalized = rule.toLowerCase();
  if (normalized === "public" || normalized === "any" || normalized === "*") {
    return { effect, kind: "public", value: "*" };
  }

  const [kindRaw, ...rest] = rule.split(":");
  const kind = kindRaw?.trim().toLowerCase();
  const value = rest.join(":").trim();
  if (!kind || !value) {
    return null;
  }
  if (kind !== "scope" && kind !== "agent" && kind !== "workspace") {
    return null;
  }

  return {
    effect,
    kind,
    value,
  };
}

/**
 * Evaluate ACL rules against agent claims.
 *
 * Security model: **default-open**. When no permissions array is provided
 * (or it is empty), access is allowed. When enforceable rules exist but
 * none match the caller's claims, access is **denied**.
 */
export function filePermissionAllows(
  permissions: string[] | undefined,
  workspaceId: string,
  claims: TokenClaims | null,
): boolean {
  if (!permissions || permissions.length === 0) {
    console.warn(
      "[relayauth] ACL default-open: no permission rules found — granting access. " +
        "Configure explicit permissions to enforce access control.",
    );
    return true;
  }

  let enforceableRuleSeen = false;
  let allowMatch = false;
  for (const raw of permissions) {
    const rule = parsePermissionRule(raw);
    if (!rule) {
      continue;
    }
    enforceableRuleSeen = true;

    let match = false;
    switch (rule.kind) {
      case "public":
        match = true;
        break;
      case "scope":
        match = claims?.scopes.has(rule.value) ?? false;
        break;
      case "agent":
        match = claims?.agentName === rule.value;
        break;
      case "workspace":
        match = workspaceId === rule.value;
        break;
    }

    if (!match) {
      continue;
    }
    if (rule.effect === "deny") {
      return false;
    }
    allowMatch = true;
  }

  if (allowMatch) {
    return true;
  }
  if (!enforceableRuleSeen) {
    console.warn(
      "[relayauth] ACL default-open: permission rules present but none were enforceable — granting access.",
    );
    return true;
  }
  return false;
}

export function resolveFilePermissions(
  storage: AclStorageAdapter,
  path: string,
  includeTarget: boolean,
): string[] {
  const target = normalizePath(path);
  const permissions: string[] = [];

  for (const dir of ancestorDirectories(target)) {
    const markerPath = joinPath(dir, DIRECTORY_PERMISSION_MARKER);
    if (markerPath === target) {
      continue;
    }

    const marker = storage.getFile(markerPath);
    if (!marker) {
      continue;
    }

    if ((marker.semantics.permissions?.length ?? 0) === 0) {
      continue;
    }
    permissions.push(...(marker.semantics.permissions ?? []));
  }

  if (includeTarget) {
    const file = storage.getFile(target);
    if (file && (file.semantics.permissions?.length ?? 0) > 0) {
      permissions.push(...(file.semantics.permissions ?? []));
    }
  }

  return permissions;
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = prefixed.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") {
      continue;
    } else if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const result = "/" + resolved.join("/");
  return result.length > 1 ? result.replace(/\/+$/, "") : "/";
}

export function joinPath(base: string, child: string): string {
  const normalizedBase = normalizePath(base);
  return normalizedBase === "/"
    ? normalizePath(`/${child}`)
    : normalizePath(`${normalizedBase}/${child}`);
}

export function ancestorDirectories(path: string): string[] {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const dirs = ["/"];
  let current = "";

  for (let index = 0; index < Math.max(0, parts.length - 1); index += 1) {
    current = joinPath(current || "/", parts[index] ?? "");
    dirs.push(current);
  }

  return dirs;
}
