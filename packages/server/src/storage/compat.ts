import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { AuthStorage, AuditStorage, PolicyStorage, RoleStorage } from "./interface.js";
import { createCloudflareStorage, createDatabaseStorage, type CloudflareStorageBindings } from "./cloudflare.js";

type RoleStorageSource = D1Database | RoleStorage | Pick<AuthStorage, "roles">;
type PolicyStorageSource = D1Database | PolicyStorage | Pick<AuthStorage, "policies">;
type AuditStorageSource = D1Database | AuditStorage | Pick<AuthStorage, "audit">;
type AuthStorageSource = D1Database | AuthStorage;

export function resolveAuthStorage(source: AuthStorageSource): AuthStorage {
  return isD1Database(source) ? createDatabaseStorage(source) : source;
}

export function resolveRoleStorage(source: RoleStorageSource): RoleStorage {
  if (isD1Database(source)) {
    return createDatabaseStorage(source).roles;
  }

  return "roles" in source ? source.roles : source;
}

export function resolvePolicyStorage(source: PolicyStorageSource): PolicyStorage {
  if (isD1Database(source)) {
    return createDatabaseStorage(source).policies;
  }

  return "policies" in source ? source.policies : source;
}

export function resolveAuditStorage(source: AuditStorageSource): AuditStorage {
  if (isD1Database(source)) {
    return createDatabaseStorage(source).audit;
  }

  return "audit" in source ? source.audit : source;
}

export function resolveContextStorage(c: Context<AppEnv>): AuthStorage {
  try {
    const storage = c.get("storage");
    if (storage) {
      return storage;
    }
  } catch {
    // Fall through to binding-backed storage resolution.
  }

  return createCloudflareStorage(c.env as unknown as CloudflareStorageBindings);
}

function isD1Database(value: unknown): value is D1Database {
  return typeof value === "object"
    && value !== null
    && "prepare" in value
    && typeof (value as { prepare?: unknown }).prepare === "function";
}
