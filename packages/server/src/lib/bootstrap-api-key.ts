import { extractPrefix, hashApiKey } from "./api-keys.js";
import type { AuthStorage } from "../storage/index.js";

export const BOOTSTRAP_API_KEY_SCOPE = "relayauth:assertion:create:relayhistory";
export const DEFAULT_BOOTSTRAP_API_KEY_ORG = "org_selfhost";
export const BOOTSTRAP_API_KEY_NAME = "selfhost-bootstrap-relayhistory-assertion";
const MIN_BOOTSTRAP_API_KEY_LENGTH = 32;

export type BootstrapApiKeyResult =
  | { status: "created"; id: string; prefix: string }
  | { status: "exists"; id: string; prefix: string }
  | { status: "revoked"; id: string; prefix: string }
  | { status: "scope_mismatch"; id: string; prefix: string; scopes: string[] };

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
  const existing = await storage.apiKeys.getByHash(keyHash);
  if (existing) {
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
    return { status: "exists", id: existing.id, prefix: existing.prefix };
  }

  const created = await storage.apiKeys.create({
    orgId: options.orgId?.trim() || DEFAULT_BOOTSTRAP_API_KEY_ORG,
    name: options.name?.trim() || BOOTSTRAP_API_KEY_NAME,
    prefix,
    keyHash,
    scopes: [BOOTSTRAP_API_KEY_SCOPE],
  });
  return { status: "created", id: created.id, prefix: created.prefix };
}
