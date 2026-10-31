import { extractPrefix, generateApiKey, hashApiKey } from "./api-keys.js";
import { SESSION_DIRECTORY_BOOTSTRAP_API_KEY_NAME } from "./bootstrap-api-key.js";
import { SESSION_DIRECTORY_SEARCH_MINT_SCOPE } from "./session-directory-issuer.js";
import type { AuthStorage } from "../storage/index.js";
import type { AuditLogWriteEntry } from "../storage/interface.js";
import type { StoredApiKey } from "../storage/api-key-types.js";

/**
 * The platform bootstrap scope. A key holding it may create the dedicated,
 * single-scope keys listed in DEDICATED_API_KEY_TYPES, and nothing else.
 *
 * It is a platform scope, not an org grant:
 * - it is satisfied only by the exact literal (`*` and `relayauth:*:manage:*`
 *   imply it under matchScope, so routes must use matchBrokerScopeExactly);
 * - it can never be delegated through the API, not even by a key that holds
 *   it (see firstUndelegableBrokerScope), so the only way to create one is
 *   ensurePlatformBootstrapApiKey, run by an operator against storage;
 * - only a plain API key carrying it as its one scope may use it. Bearer
 *   tokens and identity JWTs never qualify, because identity scopes are
 *   freely assignable within an org.
 */
export const PLATFORM_BOOTSTRAP_SCOPE = "relayauth:platform:create:dedicated-api-key";
export const PLATFORM_BOOTSTRAP_API_KEY_NAME = "platform-bootstrap";

export { isPlatformScope } from "./broker-scopes.js";

export type DedicatedApiKeyType = {
  /** The one scope the created key carries. */
  scope: string;
  /** The stored key name. */
  name: string;
};

/**
 * The only keys the platform route may create, by type name. A request names
 * a type, never scopes, so adding a key type is a reviewed code change here.
 */
export const DEDICATED_API_KEY_TYPES: Readonly<Record<string, DedicatedApiKeyType>> = Object.freeze({
  "session-directory-search": Object.freeze({
    scope: SESSION_DIRECTORY_SEARCH_MINT_SCOPE,
    name: SESSION_DIRECTORY_BOOTSTRAP_API_KEY_NAME,
  }),
});

export function resolveDedicatedApiKeyType(type: unknown): (DedicatedApiKeyType & { type: string }) | undefined {
  if (typeof type !== "string" || !Object.hasOwn(DEDICATED_API_KEY_TYPES, type)) {
    return undefined;
  }
  return { type, ...DEDICATED_API_KEY_TYPES[type]! };
}

/** True when the key is active and carries exactly this one scope. */
export function holdsExactlyScope(apiKey: StoredApiKey, scope: string): boolean {
  return !apiKey.revokedAt
    && (apiKey.kind ?? "api_key") === "api_key"
    && apiKey.scopes.length === 1
    && apiKey.scopes[0] === scope;
}

const LIST_PAGE_SIZE = 100;

/** The first active plain key in `orgId` whose only scope is `scope`. */
export async function findActiveExactScopeApiKey(
  storage: Pick<AuthStorage, "apiKeys">,
  orgId: string,
  scope: string,
): Promise<StoredApiKey | undefined> {
  let cursorId: string | undefined;
  for (;;) {
    const page = await storage.apiKeys.list(orgId, {
      limit: LIST_PAGE_SIZE,
      cursorId,
      includeRevoked: false,
    });
    const match = page.find((apiKey) => holdsExactlyScope(apiKey, scope));
    if (match) return match;
    if (page.length < LIST_PAGE_SIZE) return undefined;
    cursorId = page[page.length - 1]?.id;
    if (!cursorId) return undefined;
  }
}

export type EnsureExactScopeApiKeyResult =
  | { status: "created"; apiKey: StoredApiKey; key: string }
  | { status: "exists"; apiKey: StoredApiKey };

/**
 * Idempotently ensure `orgId` has one active plain key carrying exactly
 * `scope`. When one exists nothing is written and no plaintext is returned
 * (a lost value is recovered by revoking the key and running again). When
 * none exists a key is generated, only its hash and display prefix are
 * stored, an audit entry is written, and the plaintext is returned once. If
 * the audit write fails the new key is revoked before the error propagates.
 *
 * Two callers racing on an empty org can each create a key; both are then
 * listed, and the extra one should be revoked. Operators run this once.
 */
export async function ensureExactScopeApiKey(
  storage: Pick<AuthStorage, "apiKeys" | "audit">,
  options: { orgId: string; scope: string; name: string; actorId: string; resource: string },
): Promise<EnsureExactScopeApiKeyResult> {
  const orgId = options.orgId.trim();
  if (!orgId) throw new Error("orgId is required");
  const existing = await findActiveExactScopeApiKey(storage, orgId, options.scope);
  if (existing) return { status: "exists", apiKey: existing };

  const key = generateApiKey();
  const apiKey = await storage.apiKeys.create({
    orgId,
    name: options.name,
    prefix: extractPrefix(key),
    keyHash: hashApiKey(key),
    scopes: [options.scope],
  });
  try {
    await storage.audit.write(dedicatedKeyAuditEntry({
      action: "token.issued",
      result: "allowed",
      actorId: options.actorId,
      orgId,
      resource: options.resource,
      metadata: { apiKeyId: apiKey.id, scope: options.scope, outcome: "created" },
    }));
  } catch (error) {
    // No unaudited dedicated key: revoke it so a re-run creates a fresh one.
    await storage.apiKeys.revoke(apiKey.id, new Date().toISOString());
    throw error;
  }
  return { status: "created", apiKey, key };
}

/**
 * Operator step: ensure the environment's one platform bootstrap key exists.
 * Run once per environment with direct storage access (there is no API path
 * to this key). Deliver the returned plaintext straight to the secret store.
 */
export async function ensurePlatformBootstrapApiKey(
  storage: Pick<AuthStorage, "apiKeys" | "audit">,
  options: { orgId: string; operator: string },
): Promise<EnsureExactScopeApiKeyResult> {
  const operator = options.operator.trim();
  if (!operator) throw new Error("operator is required for the audit trail");
  return ensureExactScopeApiKey(storage, {
    orgId: options.orgId,
    scope: PLATFORM_BOOTSTRAP_SCOPE,
    name: PLATFORM_BOOTSTRAP_API_KEY_NAME,
    actorId: `operator:${operator}`,
    resource: "platform-bootstrap-api-key",
  });
}

export function dedicatedKeyAuditEntry(options: {
  action: "token.issued" | "scope.denied";
  result: "allowed" | "denied";
  actorId: string;
  orgId: string;
  resource: string;
  metadata: Record<string, string>;
}): AuditLogWriteEntry {
  return {
    id: crypto.randomUUID(),
    action: options.action,
    identityId: options.actorId,
    orgId: options.orgId,
    plane: "relayauth",
    resource: options.resource,
    result: options.result,
    metadata: options.metadata,
    timestamp: new Date().toISOString(),
  };
}
