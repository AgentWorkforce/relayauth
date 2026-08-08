import crypto from "node:crypto";
import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";

import type { AppEnv } from "../env.js";
import { authenticateAndAuthorizeFromContext } from "../lib/auth.js";
import { rsaPublicJwkFromPem } from "../lib/jwk.js";
import { keyIdFromPublicJwk, signRs256Payload } from "../lib/sign-rs256.js";
import type { StoredApiKey } from "../storage/api-key-types.js";
import type {
  AttestationGrant,
  AttestationLedgerAppendInput,
} from "../storage/index.js";
import { isStorageError } from "../storage/index.js";

type GrantRequest = {
  agentId?: unknown;
  repo?: unknown;
  taskRef?: unknown;
  expiresIn?: unknown;
  late?: unknown;
};

type FinalizeRequest = {
  jti?: unknown;
  commits?: unknown;
};

type FinalizeCommit = { sha: string };

const ATTEST_GRANT_SCOPE = "relayauth:attest:grant:*";
const DEFAULT_GRANT_TTL_SECONDS = 60 * 60;
const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;
const MAX_FINALIZE_COMMITS = 100;

const attestations = new Hono<AppEnv>();

attestations.post("/grants", async (c) => {
  const body = await parseJsonObjectBody<GrantRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }
  if (body.late !== undefined && typeof body.late !== "boolean") {
    return c.json({ error: "late must be a boolean", code: "invalid_request" }, 400);
  }

  const auth = await authenticateAndAuthorizeFromContext(c, ATTEST_GRANT_SCOPE, matchScope);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const storage = c.get("storage");
  const late = body.late === true;
  const workspaceToken = late
    ? null
    : await resolveWorkspaceToken(storage.apiKeys, auth.claims.meta?.apiKeyId);
  if (!late && !workspaceToken) {
    return c.json({ error: "workspace_token_required", code: "workspace_token_required" }, 401);
  }
  if (
    late &&
    (c.get("apiKeyVia") !== "api_key" || auth.claims.meta?.apiKeyKind !== "api_key")
  ) {
    return c.json({ error: "operator_api_key_required", code: "operator_api_key_required" }, 403);
  }

  const agentId = normalizeRequiredString(body.agentId);
  const repo = normalizeRequiredString(body.repo);
  const taskRef = normalizeOptionalString(body.taskRef);
  const expiresIn = normalizeGrantTtl(body.expiresIn);
  if (!agentId || !repo) {
    return c.json({ error: "agentId and repo are required", code: "invalid_request" }, 400);
  }
  if (!expiresIn) {
    return c.json(
      {
        error: `expiresIn must be an integer between 1 and ${MAX_GRANT_TTL_SECONDS}`,
        code: "invalid_request",
      },
      400,
    );
  }

  const identity = await storage.identities.get(agentId);
  if (
    !identity ||
    identity.orgId !== auth.claims.org ||
    (workspaceToken && identity.workspaceId !== workspaceToken.workspaceId)
  ) {
    return c.json({ error: "identity_not_found", code: "identity_not_found" }, 404);
  }

  const createdAt = new Date().toISOString();
  const finalizeKey = crypto.randomBytes(32).toString("base64url");
  const grant: AttestationGrant = {
    jti: `att_${crypto.randomUUID().replace(/-/g, "")}`,
    orgId: identity.orgId,
    agentId: identity.id,
    sponsorId: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    repo,
    ...(taskRef ? { taskRef } : {}),
    notAfter: new Date(Date.now() + expiresIn * 1000).toISOString(),
    finalizeKeyHash: hashFinalizeKey(finalizeKey),
    late,
    createdAt,
  };

  try {
    await storage.attestationGrants.create(grant);
  } catch (error) {
    return storageErrorResponse(c, error);
  }

  return c.json({
    jti: grant.jti,
    agentId: grant.agentId,
    sponsorId: grant.sponsorId,
    sponsorChain: grant.sponsorChain,
    repo: grant.repo,
    notAfter: grant.notAfter,
    finalizeKey,
    late: grant.late,
  }, 201);
});

attestations.post("/finalize", async (c) => {
  const finalizeKey = extractBearerSecret(c.req.header("authorization"));
  if (!finalizeKey) {
    return c.json({ error: "invalid_finalize_key", code: "invalid_finalize_key" }, 401);
  }

  const body = await parseJsonObjectBody<FinalizeRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
  }
  const jti = normalizeRequiredString(body.jti);
  const commits = normalizeFinalizeCommits(body.commits);
  if (!jti || !commits) {
    return c.json({ error: "jti and commits are required", code: "invalid_request" }, 400);
  }

  const storage = c.get("storage");
  const grant = await storage.attestationGrants.get(jti);
  const finalizeKeyHash = hashFinalizeKey(finalizeKey);
  if (!grant || !constantTimeEquals(finalizeKeyHash, grant.finalizeKeyHash)) {
    return c.json({ error: "invalid_finalize_key", code: "invalid_finalize_key" }, 401);
  }
  if (grant.redeemedAt) {
    return c.json({ error: "attestation_grant_redeemed", code: "attestation_grant_redeemed" }, 409);
  }
  if (Date.parse(grant.notAfter) <= Date.now()) {
    return c.json({ error: "attestation_grant_expired", code: "attestation_grant_expired" }, 410);
  }

  const ts = new Date().toISOString();
  const ledgerEntries: AttestationLedgerAppendInput[] = [];
  const responseAttestations: Array<{ sha: string; jws: string }> = [];
  for (const commit of commits) {
    const payload = {
      commitSha: commit.sha,
      agentId: grant.agentId,
      sponsorId: grant.sponsorId,
      sponsorChain: [...grant.sponsorChain],
      repo: grant.repo,
      ts,
      jti: grant.jti,
    };
    const jws = await signAttestation(c, payload);
    ledgerEntries.push({
      orgId: grant.orgId,
      entryType: "attestation.created",
      jti: grant.jti,
      commitSha: commit.sha,
      repo: grant.repo,
      agentId: grant.agentId,
      sponsorId: grant.sponsorId,
      payload,
      jws,
      createdAt: ts,
      late: grant.late,
    });
    responseAttestations.push({ sha: commit.sha, jws });
  }

  try {
    await storage.attestationGrants.redeemWithLedgerEntries({
      jti: grant.jti,
      finalizeKeyHash,
      redeemedAt: ts,
      ledgerEntries,
    });
  } catch (error) {
    return storageErrorResponse(c, error);
  }

  return c.json({ attestations: responseAttestations }, 201);
});

export default attestations;

async function signAttestation(
  c: Context<AppEnv>,
  payload: Record<string, unknown>,
): Promise<string> {
  const privateKey = c.env.RELAYAUTH_SIGNING_KEY_PEM?.trim();
  const publicKey = c.env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC?.trim();
  if (!privateKey || !publicKey) {
    throw new Error("RelayAuth RSA signing key pair must be configured");
  }
  const kid = await keyIdFromPublicJwk(await rsaPublicJwkFromPem(publicKey, ""));
  return signRs256Payload(payload, privateKey, kid);
}

async function resolveWorkspaceToken(
  apiKeys: { get(id: string): Promise<StoredApiKey | null> },
  apiKeyId: string | undefined,
): Promise<StoredApiKey | null> {
  const id = normalizeOptionalString(apiKeyId);
  if (!id) return null;
  const apiKey = await apiKeys.get(id);
  return apiKey?.kind === "workspace_token" && !apiKey.revokedAt ? apiKey : null;
}

function normalizeGrantTtl(value: unknown): number | null {
  if (value === undefined) return DEFAULT_GRANT_TTL_SECONDS;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_GRANT_TTL_SECONDS
    ? value
    : null;
}

function normalizeFinalizeCommits(value: unknown): FinalizeCommit[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FINALIZE_COMMITS) {
    return null;
  }
  const seen = new Set<string>();
  const commits: FinalizeCommit[] = [];
  for (const item of value) {
    const sha = typeof item === "object" && item !== null
      ? normalizeRequiredString((item as { sha?: unknown }).sha)
      : undefined;
    if (!sha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(sha) || seen.has(sha)) {
      return null;
    }
    seen.add(sha);
    commits.push({ sha });
  }
  return commits;
}

function parseJsonObjectBody<T>(request: Request): Promise<T | null> {
  return request.json().then((body) =>
    body && typeof body === "object" && !Array.isArray(body) ? body as T : null,
  ).catch(() => null);
}

function extractBearerSecret(authorization: string | undefined): string | undefined {
  const [scheme, secret] = authorization?.split(/\s+/, 2) ?? [];
  return scheme === "Bearer" && secret?.trim() ? secret.trim() : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRequiredString(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function hashFinalizeKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function storageErrorResponse(c: Context<AppEnv>, error: unknown): Response {
  if (isStorageError(error)) {
    return c.json(
      { error: error.message, code: error.code },
      error.status as 401 | 404 | 409 | 410,
    );
  }
  throw error;
}
