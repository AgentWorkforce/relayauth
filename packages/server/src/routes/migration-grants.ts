import crypto from "node:crypto";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";

import type { AppEnv } from "../env.js";
import { authenticateFromContext, authorizeClaims } from "../lib/auth.js";
import {
  auditMetadata,
  auditValue,
  checkMigrationSourceUser,
  createMigrationGrantId,
  MAX_MIGRATION_GRANT_TTL_SECONDS,
  MIGRATION_ASSERTION_SCOPE,
  MIGRATION_GRANT_IDEMPOTENCY_HEADER,
  MIGRATION_GRANT_MANAGE_SCOPE,
  MIGRATION_GRANT_REPLAYED_HEADER,
  migrationGrantIdempotencyKeyHash,
  parseMigrationGrantIdempotencyKey,
  writeMigrationDenialAudit,
} from "../lib/migration-grants.js";
import {
  canonicalMigrationId,
  canonicalMigrationJson,
  deriveMigrationGrantPlan,
  migrationAllowedPairHash,
  MigrationPlanError,
  migrationSha256,
  type MigrationGrantPair,
  type MigrationGrantPlan,
} from "../lib/migration-plan.js";
import {
  isStorageError,
  isValidAuditTimestamp,
  StorageError,
  type AuditLogWriteEntry,
  type MigrationGrant,
} from "../storage/index.js";
import { normalizeRelayhistoryAssertionOrigin } from "./tokens.js";

type CreateMigrationGrantRequest = {
  apiKeyId?: unknown;
  audience?: unknown;
  plan?: unknown;
  notAfter?: unknown;
};

type MigrationGrantResponse = {
  grantId: string;
  orgId: string;
  apiKeyId: string;
  planDigest: string;
  audience: string;
  allowedPairs: MigrationGrantPair[];
  planEntries: number;
  notAfter: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};

type Refusal = {
  error: string;
  code: string;
  status: 400 | 403 | 404 | 409 | 501;
  sourceUserId?: string;
  pairHash?: string;
  /** Hash only; the raw Idempotency-Key is never audited. */
  idempotencyKeyHash?: string;
};

const migrationGrants = new Hono<AppEnv>();

migrationGrants.post("/", async (c) => {
  const auth = await authenticateFromContext(c);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const body = await parseJsonObjectBody<CreateMigrationGrantRequest>(c.req.raw);
  // Every refusal past authentication is audited against the caller's org.
  // The raw Idempotency-Key never reaches this audit row or the response.
  const refuse = async (refusal: Refusal) => {
    await writeMigrationDenialAudit(c.get("storage"), {
      action: "migration_grant.created",
      identityId: auth.claims.sub,
      orgId: auth.claims.org,
      resource: "migration-grant",
      metadata: auditMetadata({
        reason: refusal.code,
        apiKeyId: auditValue(body?.apiKeyId),
        audience: auditValue(body?.audience),
        pairHash: refusal.pairHash,
        idempotencyKeyHash: refusal.idempotencyKeyHash,
      }),
    });
    return c.json(
      {
        error: refusal.error,
        code: refusal.code,
        ...(refusal.sourceUserId
          ? { sourceUserId: refusal.sourceUserId }
          : {}),
      },
      refusal.status,
    );
  };

  const authz = authorizeClaims(auth.claims, MIGRATION_GRANT_MANAGE_SCOPE, matchScope);
  if (!authz.ok) {
    return refuse({ error: authz.error, code: authz.code, status: authz.status });
  }

  const storage = c.get("storage");
  if (!storage.migrationGrants) {
    return refuse(unsupportedRefusal());
  }

  // While issuance is disabled the only thing this route may still do is hand
  // an existing grant back to the caller that created it. Any other outcome is
  // the same disabled refusal as before idempotency existed.
  const issuanceEnabled = c.env.RELAYAUTH_ENABLE_MIGRATION_ASSERTIONS === "true";
  const disabledRefusal: Refusal = {
    error: "migration assertions are disabled",
    code: "migration_assertions_disabled",
    status: 403,
  };
  const refuseBeforeRecovery = (refusal: Refusal) =>
    refuse(issuanceEnabled ? refusal : disabledRefusal);

  const idempotencyKey = parseMigrationGrantIdempotencyKey(
    c.req.header(MIGRATION_GRANT_IDEMPOTENCY_HEADER),
  );
  if (!idempotencyKey.ok) {
    return refuseBeforeRecovery(idempotencyKey);
  }

  if (!body) {
    return refuseBeforeRecovery({ error: "Invalid JSON body", code: "invalid_request", status: 400 });
  }

  const originPolicy = {
    allowPrivateHttpOrigin:
      c.env.RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN === "true",
  };
  const fingerprinted = fingerprintCreateMigrationGrantRequest(
    body,
    originPolicy,
    auth.claims.org,
  );
  if (!fingerprinted.ok) {
    return refuseBeforeRecovery(fingerprinted);
  }

  const callerId = auth.claims.sub;
  const idempotencyKeyHash = migrationGrantIdempotencyKeyHash({
    orgId: fingerprinted.orgId,
    callerId,
    key: idempotencyKey.key,
  });
  const idempotency = {
    keyHash: idempotencyKeyHash,
    callerId,
    requestFingerprint: fingerprinted.requestFingerprint,
  };
  const replayOrConflict = (
    result:
      | { outcome: "replayed"; grant: MigrationGrant }
      | { outcome: "conflict" },
  ) => {
    if (result.outcome === "conflict") {
      return refuse(idempotencyConflict(idempotencyKeyHash));
    }
    // Recovery returns the stored record exactly as it is: same grantId,
    // digest, notAfter and revocation state. It never extends, re-arms or
    // re-audits the grant, so it is safe while issuance is disabled or after
    // the grant expired or was revoked.
    c.header(MIGRATION_GRANT_REPLAYED_HEADER, "true");
    return c.json<MigrationGrantResponse>(toMigrationGrantResponse(result.grant), 201);
  };

  try {
    const existing = await storage.migrationGrants.findByIdempotencyKey({
      orgId: fingerprinted.orgId,
      keyHash: idempotencyKeyHash,
      callerId,
    });
    if (existing) {
      if (existing.requestFingerprint !== fingerprinted.requestFingerprint) {
        return replayOrConflict({ outcome: "conflict" });
      }
      if (!existing.grant) {
        throw new StorageError(
          "migration grant idempotency receipt has no readable grant",
          500,
          "migration_grant_receipt_unreadable",
        );
      }
      return replayOrConflict({ outcome: "replayed", grant: existing.grant });
    }
  } catch (error) {
    return handleMigrationGrantError(c, error);
  }

  if (!issuanceEnabled) {
    return refuse(disabledRefusal);
  }

  const request = normalizeCreateMigrationGrantRequest(
    body,
    fingerprinted,
    originPolicy,
    createMigrationGrantId(),
  );
  if (!request.ok) {
    return refuse(request);
  }

  // The grant names the one key that may mint under it. That key must be a
  // live operator API key of the caller's org whose only scope is the
  // migration scope, so it can neither manage grants nor do anything else.
  const apiKey = await storage.apiKeys.get(request.apiKeyId);
  let apiKeyOrgId: string | undefined;
  try {
    apiKeyOrgId = apiKey
      ? canonicalMigrationId(apiKey.orgId, "organization id")
      : undefined;
  } catch {
    apiKeyOrgId = undefined;
  }
  if (!apiKey || apiKeyOrgId !== request.orgId) {
    return refuse({ error: "api_key_not_found", code: "api_key_not_found", status: 404 });
  }
  if (apiKey.revokedAt) {
    return refuse({ error: "API key is revoked", code: "api_key_revoked", status: 409 });
  }
  if ((apiKey.kind ?? "api_key") !== "api_key") {
    return refuse({
      error: "migration grants bind an operator api key, not a workspace token",
      code: "migration_key_not_dedicated",
      status: 400,
    });
  }
  if (!apiKey.scopes.includes(MIGRATION_ASSERTION_SCOPE)) {
    return refuse({
      error: `API key must carry ${MIGRATION_ASSERTION_SCOPE}`,
      code: "migration_scope_missing",
      status: 400,
    });
  }
  if (apiKey.scopes.some((scope) => scope !== MIGRATION_ASSERTION_SCOPE)) {
    return refuse({
      error: `API key must carry ${MIGRATION_ASSERTION_SCOPE} and no other scope`,
      code: "migration_key_not_dedicated",
      status: 400,
    });
  }

  for (const userId of new Set(
    request.allowedPairs.map((pair) => pair.sourceUserId),
  )) {
    const sourceUser = await checkMigrationSourceUser(
      storage,
      request.orgId,
      userId,
    );
    if (!sourceUser.ok) {
      const pair = request.allowedPairs.find(
        (candidate) => candidate.sourceUserId === userId,
      )!;
      return refuse({
        ...sourceUser,
        sourceUserId: userId,
        pairHash: migrationAllowedPairHash([pair]),
      });
    }
  }

  const grant: MigrationGrant = {
    grantId: request.grantId,
    orgId: request.orgId,
    apiKeyId: apiKey.id,
    planDigest: request.planDigest,
    plan: request.plan,
    audience: request.audience,
    allowedPairs: request.allowedPairs,
    notAfter: request.notAfter,
    createdBy: callerId,
    createdAt: new Date().toISOString(),
  };

  try {
    const auditEntry = createGrantAuditEntry("migration_grant.created", auth.claims, grant);
    auditEntry.metadata = {
      ...auditEntry.metadata,
      idempotencyKeyHash,
      requestFingerprint: fingerprinted.requestFingerprint,
    };
    const result = await storage.migrationGrants.createWithAudit({
      grant,
      auditEntry,
      idempotency,
    });
    if (result.outcome === "created") {
      return c.json<MigrationGrantResponse>(toMigrationGrantResponse(result.grant), 201);
    }
    // A concurrent create with the same key committed first.
    return replayOrConflict(result);
  } catch (error) {
    return handleMigrationGrantError(c, error);
  }
});

migrationGrants.post("/:grantId/revoke", async (c) => {
  const auth = await authenticateFromContext(c);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const grantId = normalizeOptionalString(c.req.param("grantId"));
  const refuse = async (refusal: Refusal) => {
    await writeMigrationDenialAudit(c.get("storage"), {
      action: "migration_grant.revoked",
      identityId: auth.claims.sub,
      orgId: auth.claims.org,
      resource: "migration-grant",
      metadata: auditMetadata({
        reason: refusal.code,
        grantId: auditValue(grantId),
      }),
    });
    return c.json({ error: refusal.error, code: refusal.code }, refusal.status);
  };

  const authz = authorizeClaims(auth.claims, MIGRATION_GRANT_MANAGE_SCOPE, matchScope);
  if (!authz.ok) {
    return refuse({ error: authz.error, code: authz.code, status: authz.status });
  }

  const storage = c.get("storage");
  if (!storage.migrationGrants) {
    return refuse(unsupportedRefusal());
  }
  if (!grantId) {
    return refuse(grantNotFound());
  }

  const existing = await storage.migrationGrants.get(grantId);
  let callerOrgId: string;
  try {
    callerOrgId = canonicalMigrationId(auth.claims.org, "organization id");
  } catch {
    return refuse(grantNotFound());
  }
  if (!existing || existing.orgId !== callerOrgId) {
    return refuse(grantNotFound());
  }

  try {
    const revoked = await storage.migrationGrants.revokeWithAudit({
      grantId,
      orgId: callerOrgId,
      revokedAt: new Date().toISOString(),
      auditEntry: createGrantAuditEntry("migration_grant.revoked", auth.claims, existing),
    });
    return c.json<MigrationGrantResponse>(toMigrationGrantResponse(revoked), 200);
  } catch (error) {
    if (isStorageError(error) && (error.status === 404 || error.status === 409)) {
      return refuse({
        error: error.message,
        code: error.code,
        status: error.status as 404 | 409,
      });
    }
    return handleMigrationGrantError(c, error);
  }
});

export default migrationGrants;

type FingerprintedCreateMigrationGrantRequest = {
  ok: true;
  orgId: string;
  apiKeyId: string;
  /** Canonical notAfter; not yet checked against the creation window. */
  notAfter: string;
  requestFingerprint: string;
};

/**
 * Validates the request shape and computes the canonical pre-grant request
 * fingerprint: everything the caller chose (key id, audience, notAfter, the
 * canonical plan and its derived pairs) and nothing the server generates.
 * Checks that depend on the current time or deployment policy (the notAfter
 * window, the private-http audience flag) are applied only to a fresh create,
 * so a retry still recovers an expired grant or one created under an earlier
 * policy.
 */
function fingerprintCreateMigrationGrantRequest(
  value: CreateMigrationGrantRequest,
  originPolicy: { allowPrivateHttpOrigin: boolean },
  callerOrgId: string,
): FingerprintedCreateMigrationGrantRequest | (Refusal & { ok: false; status: 400 }) {
  if (!hasExactKeys(value, ["apiKeyId", "audience", "plan", "notAfter"])) {
    return {
      ok: false,
      error: "request has missing or unsupported fields",
      code: "invalid_request",
      status: 400,
    };
  }
  const apiKeyId = normalizeOptionalString(value.apiKeyId);
  if (!apiKeyId) {
    return { ok: false, error: "apiKeyId is required", code: "apiKeyId_required", status: 400 };
  }

  const audience = normalizeMigrationAudience(value.audience, {
    allowPrivateHttpOrigin: true,
  });
  if (!audience) {
    return invalidAudience(originPolicy);
  }

  let derived: ReturnType<typeof deriveMigrationGrantPlan>;
  let orgId: string;
  try {
    orgId = canonicalMigrationId(callerOrgId, "organization id");
    derived = deriveMigrationGrantPlan({
      grantId: FINGERPRINT_GRANT_ID,
      orgId,
      plan: value.plan,
    });
  } catch (error) {
    return invalidPlan(error);
  }

  if (!isValidAuditTimestamp(value.notAfter)) {
    return invalidNotAfter();
  }
  const notAfter = new Date(Date.parse(value.notAfter)).toISOString();

  const fingerprintInput = {
    v: 1,
    org_id: orgId,
    api_key_id: apiKeyId,
    audience,
    not_after: notAfter,
    allowed_pairs: derived.allowedPairs.map((pair) => ({
      source_user_id: pair.sourceUserId,
      workspace_id: pair.workspaceId,
    })),
    plan: migrationGrantFingerprintPlan(derived.plan),
  };
  return {
    ok: true,
    orgId,
    apiKeyId,
    notAfter,
    requestFingerprint: migrationSha256(canonicalMigrationJson(fingerprintInput)),
  };
}

/**
 * The derived plan with every generated `grant_id` removed: the plan's own
 * and each entry's in `manifests` and, once plan entry v2 (relayauth #117)
 * lands, in `backfills`. A v1 plan has no `backfills` key, so its
 * fingerprint is unchanged by the second list. Everything else, including
 * `v`, is kept, so a v1 and a v2 plan never share a fingerprint.
 */
export function migrationGrantFingerprintPlan(
  plan: object,
): Record<string, unknown> {
  const { grant_id: _planGrantId, ...rest } = plan as Record<string, unknown>;
  const stripped: Record<string, unknown> = { ...rest };
  for (const list of ["manifests", "backfills"] as const) {
    const entries = stripped[list];
    if (Array.isArray(entries)) {
      stripped[list] = entries.map((entry) => {
        const { grant_id: _entryGrantId, ...kept } = entry as Record<
          string,
          unknown
        >;
        return kept;
      });
    }
  }
  return stripped;
}

/** Full validation for a fresh create, binding the newly generated grantId. */
function normalizeCreateMigrationGrantRequest(
  value: CreateMigrationGrantRequest,
  fingerprinted: FingerprintedCreateMigrationGrantRequest,
  originPolicy: { allowPrivateHttpOrigin: boolean },
  grantId: string,
):
  | {
      ok: true;
      apiKeyId: string;
      planDigest: string;
      plan: MigrationGrantPlan;
      orgId: string;
      grantId: string;
      audience: string;
      allowedPairs: MigrationGrantPair[];
      notAfter: string;
    }
  | (Refusal & { ok: false; status: 400 }) {
  const audience = normalizeMigrationAudience(value.audience, originPolicy);
  if (!audience) {
    return invalidAudience(originPolicy);
  }

  let derived: ReturnType<typeof deriveMigrationGrantPlan>;
  try {
    derived = deriveMigrationGrantPlan({
      grantId,
      orgId: fingerprinted.orgId,
      plan: value.plan,
    });
  } catch (error) {
    return invalidPlan(error);
  }

  const notAfter = normalizeGrantNotAfter(fingerprinted.notAfter);
  if (!notAfter) {
    return invalidNotAfter();
  }

  return {
    ok: true,
    grantId,
    orgId: fingerprinted.orgId,
    apiKeyId: fingerprinted.apiKeyId,
    planDigest: derived.planDigest,
    plan: derived.plan,
    audience,
    allowedPairs: derived.allowedPairs,
    notAfter,
  };
}

/**
 * Stand-in grant id for deriving the fingerprint plan. It only satisfies the
 * id shape check; every grant_id it produces is stripped before hashing.
 */
const FINGERPRINT_GRANT_ID = `mgr_${"0".repeat(32)}`;

function invalidAudience(originPolicy: {
  allowPrivateHttpOrigin: boolean;
}): Refusal & { ok: false; status: 400 } {
  return {
    ok: false,
    error: originPolicy.allowPrivateHttpOrigin
      ? "audience must be an https origin, or an http origin on a private or internal host, with no path, query, fragment or credentials"
      : "audience must be an https origin with no path, query, fragment or credentials",
    code: "invalid_audience",
    status: 400,
  };
}

function invalidPlan(error: unknown): Refusal & { ok: false; status: 400 } {
  const code = error instanceof MigrationPlanError ? error.code : "invalid_plan";
  return {
    ok: false,
    error: error instanceof Error ? error.message : "plan is invalid",
    code,
    status: 400,
  };
}

function invalidNotAfter(): Refusal & { ok: false; status: 400 } {
  return {
    ok: false,
    error: `notAfter must be an ISO 8601 timestamp in the future and at most ${MAX_MIGRATION_GRANT_TTL_SECONDS / 86400} days away`,
    code: "invalid_not_after",
    status: 400,
  };
}

function idempotencyConflict(idempotencyKeyHash: string): Refusal {
  return {
    error: `${MIGRATION_GRANT_IDEMPOTENCY_HEADER} was already used for a different migration grant request`,
    code: "idempotency_key_conflict",
    status: 409,
    idempotencyKeyHash,
  };
}

/**
 * Same bare-origin rules as the History assertion's `historyOrigin`, minus
 * its default loopback-http allowance: plain http is accepted only for a
 * private or internal host, and only behind
 * RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true.
 */
function normalizeMigrationAudience(
  value: unknown,
  { allowPrivateHttpOrigin }: { allowPrivateHttpOrigin: boolean },
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const origin = normalizeRelayhistoryAssertionOrigin(value, { allowPrivateHttpOrigin });
  if (!origin.ok || !origin.origin) {
    return undefined;
  }
  if (!origin.origin.startsWith("https://") && !allowPrivateHttpOrigin) {
    return undefined;
  }
  return origin.origin;
}

function normalizeGrantNotAfter(value: unknown): string | undefined {
  if (!isValidAuditTimestamp(value)) {
    return undefined;
  }
  const notAfterMs = Date.parse(value);
  const nowMs = Date.now();
  if (notAfterMs <= nowMs || notAfterMs > nowMs + MAX_MIGRATION_GRANT_TTL_SECONDS * 1000) {
    return undefined;
  }
  return new Date(notAfterMs).toISOString();
}

function createGrantAuditEntry(
  action: "migration_grant.created" | "migration_grant.revoked",
  claims: RelayAuthTokenClaims,
  grant: MigrationGrant,
): AuditLogWriteEntry {
  return {
    id: crypto.randomUUID(),
    action,
    identityId: claims.sub,
    orgId: grant.orgId,
    plane: "relayauth",
    resource: "migration-grant",
    result: "allowed",
    metadata: {
      grantId: grant.grantId,
      apiKeyId: grant.apiKeyId,
      planDigest: grant.planDigest,
      audience: grant.audience,
      allowedPairCount: String(grant.allowedPairs.length),
      allowedPairHash: migrationAllowedPairHash(grant.allowedPairs),
      planEntries: String(grant.plan.manifests.length),
      notAfter: grant.notAfter,
    },
    timestamp: new Date().toISOString(),
  };
}

function toMigrationGrantResponse(grant: MigrationGrant): MigrationGrantResponse {
  return {
    grantId: grant.grantId,
    orgId: grant.orgId,
    apiKeyId: grant.apiKeyId,
    planDigest: grant.planDigest,
    audience: grant.audience,
    allowedPairs: grant.allowedPairs.map((pair) => ({ ...pair })),
    planEntries: grant.plan.manifests.length,
    notAfter: grant.notAfter,
    createdBy: grant.createdBy,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt ?? null,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function grantNotFound(): Refusal {
  return { error: "migration_grant_not_found", code: "migration_grant_not_found", status: 404 };
}

function unsupportedRefusal(): Refusal {
  return {
    error: "migration grants are not supported by this storage backend",
    code: "migration_grants_unsupported",
    status: 501,
  };
}

async function parseJsonObjectBody<T>(request: Request): Promise<T | null> {
  const body = await request.json().catch(() => null) as T | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return body;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function handleMigrationGrantError(c: Context<AppEnv>, error: unknown): Response {
  if (isStorageError(error)) {
    return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409);
  }

  console.error("RelayAuth migration grant failed", { error });
  return c.json({ error: "internal_error", code: "internal_error" }, 500);
}
