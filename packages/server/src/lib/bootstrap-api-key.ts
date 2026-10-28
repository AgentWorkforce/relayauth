import { extractPrefix, hashApiKey } from "./api-keys.js";
import type { AuthStorage } from "../storage/index.js";
import type { StoredApiKey } from "../storage/api-key-types.js";

export const BOOTSTRAP_API_KEY_SCOPE = "relayauth:assertion:create:relayhistory";
export const DEFAULT_BOOTSTRAP_API_KEY_ORG = "org_selfhost";
export const BOOTSTRAP_API_KEY_NAME = "selfhost-bootstrap-relayhistory-assertion";
const MIN_BOOTSTRAP_API_KEY_LENGTH = 32;

export type BootstrapApiKeyResult =
  | { status: "created"; id: string; prefix: string }
  | {
    status: "exists";
    id: string;
    prefix: string;
    /** Set when the stored key belongs to a different org than requested. */
    orgMismatch?: { stored: string; requested: string };
  }
  | { status: "revoked"; id: string; prefix: string }
  | { status: "scope_mismatch"; id: string; prefix: string; scopes: string[] };

function classifyExisting(existing: StoredApiKey, requestedOrgId: string): BootstrapApiKeyResult {
  if (existing.revokedAt) {
    return { status: "revoked", id: existing.id, prefix: existing.prefix };
  }
  if (!existing.scopes.includes(BOOTSTRAP_API_KEY_SCOPE)) {
    return {
      status: "scope_mismatch",
      id: existing.id,
      prefix: existing.prefix,
      scopes: [...existing.scopes],
    };
  }
  return {
    status: "exists",
    id: existing.id,
    prefix: existing.prefix,
    ...(existing.orgId !== requestedOrgId
      ? { orgMismatch: { stored: existing.orgId, requested: requestedOrgId } }
      : {}),
  };
}

/**
 * Idempotently ensure an API key with exactly this value exists and can mint
 * History assertions (scope relayauth:assertion:create:relayhistory).
 *
 * Only the SHA-256 hash and display prefix are stored, exactly like keys
 * minted through POST /v1/api-keys. The raw value is never logged or
 * returned. A key that already exists is left untouched: a revoked bootstrap
 * key stays revoked (rotate the file to a new value instead), and a key whose
 * scopes differ is reported rather than silently widened.
 */
export async function ensureBootstrapApiKey(
  storage: AuthStorage,
  rawValue: string,
  options: { orgId?: string; name?: string } = {},
): Promise<BootstrapApiKeyResult> {
  const apiKey = rawValue.trim();
  if (apiKey.length < MIN_BOOTSTRAP_API_KEY_LENGTH || /\s/u.test(apiKey)) {
    throw new Error(
      `RELAYAUTH_BOOTSTRAP_API_KEY_FILE must contain a single token of at least ${MIN_BOOTSTRAP_API_KEY_LENGTH} characters`,
    );
  }

  const keyHash = hashApiKey(apiKey);
  const prefix = extractPrefix(apiKey);
  const orgId = options.orgId?.trim() || DEFAULT_BOOTSTRAP_API_KEY_ORG;
  const existing = await storage.apiKeys.getByHash(keyHash);
  if (existing) {
    return classifyExisting(existing, orgId);
  }

  try {
    const created = await storage.apiKeys.create({
      orgId,
      name: options.name?.trim() || BOOTSTRAP_API_KEY_NAME,
      prefix,
      keyHash,
      scopes: [BOOTSTRAP_API_KEY_SCOPE],
    });
    return { status: "created", id: created.id, prefix: created.prefix };
  } catch (error) {
    // Another process (e.g. an overlapping pod during a restart) inserted the
    // same key between our read and write: the UNIQUE(key_hash) constraint
    // fired. Re-read and report what is there instead of failing boot.
    const raced = await storage.apiKeys.getByHash(keyHash);
    if (raced) {
      return classifyExisting(raced, orgId);
    }
    throw error;
  }
}
