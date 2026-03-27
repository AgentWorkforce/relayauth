import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { AuthStorage, AuditStorage, PolicyStorage, RoleStorage } from "./interface.js";
import { createDatabaseStorage } from "./sqlite.js";

type RoleStorageSource = RoleStorage | Pick<AuthStorage, "roles"> | unknown;
type PolicyStorageSource = PolicyStorage | Pick<AuthStorage, "policies"> | unknown;
type AuditStorageSource = AuditStorage | Pick<AuthStorage, "audit"> | unknown;
type AuthStorageSource = AuthStorage | unknown;

export function resolveAuthStorage(source: AuthStorageSource): AuthStorage {
  if (typeof source === "object" && source !== null && "prepare" in source) {
    return createDatabaseStorage(source as D1Database);
  }
  return source as AuthStorage;
}

export function resolveRoleStorage(source: RoleStorageSource): RoleStorage {
  if (typeof source === "object" && source !== null && "roles" in source) {
    return (source as Pick<AuthStorage, "roles">).roles;
  }
  return source as RoleStorage;
}

export function resolvePolicyStorage(source: PolicyStorageSource): PolicyStorage {
  if (typeof source === "object" && source !== null && "policies" in source) {
    return (source as Pick<AuthStorage, "policies">).policies;
  }
  return source as PolicyStorage;
}

export function resolveAuditStorage(source: AuditStorageSource): AuditStorage {
  if (typeof source === "object" && source !== null && "audit" in source) {
    return (source as Pick<AuthStorage, "audit">).audit;
  }
  if (typeof source === "object" && source !== null && "prepare" in source) {
    return createDatabaseStorage(source as D1Database).audit;
  }
  return source as AuditStorage;
}

export function resolveContextStorage(c: Context<AppEnv>): AuthStorage {
  const storage = c.get("storage");
  if (!storage) {
    throw new Error("storage not set in context — ensure createApp() receives a storage adapter");
  }
  return storage;
}
