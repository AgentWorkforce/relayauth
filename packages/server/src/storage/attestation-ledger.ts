import crypto from "node:crypto";

import { canonicalizeJson } from "../lib/canonical-json.js";
import {
  ATTESTATION_LEDGER_GENESIS_HASH,
  isValidAuditTimestamp,
  type AppendAttestationLedgerEntryInput,
  type AttestationLedgerEntry,
  type AttestationLedgerEntryType,
} from "./interface.js";

type LedgerRow = Record<string, unknown> & {
  seq?: number | bigint | string | null;
  org_id?: string | null;
  org_seq?: number | bigint | string | null;
  entry_type?: string | null;
  payload_json?: string | null;
  jws?: string | null;
  prev_hash?: string | null;
  entry_hash?: string | null;
  created_at?: string | null;
};

type LedgerSqliteStatement<Row extends Record<string, unknown>> = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Row | undefined;
};

/** Minimal better-sqlite3-compatible surface required by the atomic append. */
export type AttestationLedgerSqliteDatabase = {
  prepare<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): LedgerSqliteStatement<Row>;
};

type PreparedLedgerEntry = Omit<AttestationLedgerEntry, "seq">;

const SELECT_LAST_ENTRY_SQL = `
  SELECT org_seq, entry_hash
  FROM attestation_ledger
  WHERE org_id = ?
  ORDER BY org_seq DESC
  LIMIT 1
`;

const INSERT_ENTRY_SQL = `
  INSERT INTO attestation_ledger (
    org_id,
    org_seq,
    entry_type,
    payload_json,
    jws,
    prev_hash,
    entry_hash,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_INSERTED_ENTRY_SQL = `
  SELECT
    seq,
    org_id,
    org_seq,
    entry_type,
    payload_json,
    jws,
    prev_hash,
    entry_hash,
    created_at
  FROM attestation_ledger
  WHERE org_id = ? AND org_seq = ?
  LIMIT 1
`;

/**
 * Append inside a transaction owned by the caller.
 *
 * This deliberately performs no BEGIN, COMMIT, or ROLLBACK. Any validation,
 * chain, or SQL error is thrown so a surrounding business transaction can
 * fail closed.
 */
export function appendAttestationLedgerEntryInTransaction(
  db: AttestationLedgerSqliteDatabase,
  input: AppendAttestationLedgerEntryInput,
): AttestationLedgerEntry {
  const orgId = requireNonEmptyString(input.orgId, "orgId");
  const previous = db.prepare<LedgerRow>(SELECT_LAST_ENTRY_SQL).get(orgId);
  const previousOrgSeq = previous ? requirePositiveInteger(previous.org_seq, "stored org_seq") : 0;
  const previousEntryHash = previous
    ? requireSha256(previous.entry_hash, "stored entry_hash")
    : ATTESTATION_LEDGER_GENESIS_HASH;
  const prepared = prepareAttestationLedgerEntry(
    input,
    previousOrgSeq + 1,
    previousEntryHash,
  );

  db.prepare(INSERT_ENTRY_SQL).run(
    prepared.orgId,
    prepared.orgSeq,
    prepared.entryType,
    prepared.payloadJson,
    prepared.jws,
    prepared.prevHash,
    prepared.entryHash,
    prepared.createdAt,
  );

  const stored = db
    .prepare<LedgerRow>(SELECT_INSERTED_ENTRY_SQL)
    .get(prepared.orgId, prepared.orgSeq);
  if (!stored) {
    throw new Error("attestation ledger append did not return the inserted entry");
  }
  return hydrateAttestationLedgerEntry(stored);
}

export function prepareAttestationLedgerEntry(
  input: AppendAttestationLedgerEntryInput,
  orgSeq: number,
  prevHash: string,
): PreparedLedgerEntry {
  const orgId = requireNonEmptyString(input.orgId, "orgId");
  const entryType = requireEntryType(input.entryType);
  const payloadJson = canonicalizeJson(input.payload);
  const jws = requireRs256Jws(input.jws, payloadJson);
  const createdAt = normalizeTimestamp(input.createdAt);
  const normalizedOrgSeq = requirePositiveInteger(orgSeq, "orgSeq");
  const normalizedPrevHash = requireSha256(prevHash, "prevHash");

  const entryWithoutHash: Omit<PreparedLedgerEntry, "entryHash"> = {
    orgId,
    orgSeq: normalizedOrgSeq,
    entryType,
    payloadJson,
    jws,
    prevHash: normalizedPrevHash,
    createdAt,
  };

  return {
    ...entryWithoutHash,
    entryHash: recomputeAttestationLedgerEntryHash(entryWithoutHash),
  };
}

/** Recompute the hash committed by an entry without trusting entry_hash. */
export function recomputeAttestationLedgerEntryHash(
  entry: Omit<AttestationLedgerEntry, "seq" | "entryHash">,
): string {
  const payload = JSON.parse(entry.payloadJson) as unknown;
  const hashMaterial = canonicalizeJson({
    createdAt: entry.createdAt,
    entryType: entry.entryType,
    jws: entry.jws,
    orgId: entry.orgId,
    orgSeq: entry.orgSeq,
    payload,
    prevHash: entry.prevHash,
  });
  return crypto.createHash("sha256").update(hashMaterial, "utf8").digest("hex");
}

/** Verify one organization's chain from genesis through its latest entry. */
export function verifyAttestationLedgerChain(
  entries: readonly AttestationLedgerEntry[],
): boolean {
  if (entries.length === 0) {
    return true;
  }

  const sorted = [...entries].sort((left, right) => left.orgSeq - right.orgSeq);
  const orgId = sorted[0]!.orgId;
  let expectedPrevHash = ATTESTATION_LEDGER_GENESIS_HASH;

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index]!;
    try {
      if (
        entry.orgId !== orgId
        || entry.orgSeq !== index + 1
        || entry.prevHash !== expectedPrevHash
        || requireRs256Jws(entry.jws, canonicalizeJson(JSON.parse(entry.payloadJson))) !== entry.jws
        || recomputeAttestationLedgerEntryHash(entry) !== entry.entryHash
      ) {
        return false;
      }
    } catch {
      return false;
    }
    expectedPrevHash = entry.entryHash;
  }

  return true;
}

function hydrateAttestationLedgerEntry(row: LedgerRow): AttestationLedgerEntry {
  return {
    seq: requirePositiveInteger(row.seq, "stored seq"),
    orgId: requireNonEmptyString(row.org_id, "stored org_id"),
    orgSeq: requirePositiveInteger(row.org_seq, "stored org_seq"),
    entryType: requireEntryType(row.entry_type),
    payloadJson: canonicalizeJson(JSON.parse(requireNonEmptyString(row.payload_json, "stored payload_json"))),
    jws: requireNonEmptyString(row.jws, "stored jws"),
    prevHash: requireSha256(row.prev_hash, "stored prev_hash"),
    entryHash: requireSha256(row.entry_hash, "stored entry_hash"),
    createdAt: normalizeTimestamp(requireNonEmptyString(row.created_at, "stored created_at")),
  };
}

function requireRs256Jws(value: unknown, expectedPayloadJson: string): string {
  const jws = requireNonEmptyString(value, "jws");
  const segments = jws.split(".");
  if (
    segments.length !== 3
    || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))
  ) {
    throw new Error("jws must be a compact JWS with three base64url segments");
  }

  try {
    const header = JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8")) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (header.alg !== "RS256") {
      throw new Error("jws must use RS256");
    }
    if (typeof header.kid !== "string" || header.kid.trim().length === 0) {
      throw new Error("jws must identify its RS256 signing key with kid");
    }
    const signedPayload = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString("utf8"),
    ) as unknown;
    if (canonicalizeJson(signedPayload) !== expectedPayloadJson) {
      throw new Error("jws payload does not match the ledger payload");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("jws ")) {
      throw error;
    }
    throw new Error("jws header and payload must contain valid JSON", { cause: error });
  }

  return jws;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requireEntryType(value: unknown): AttestationLedgerEntryType {
  const entryType = requireNonEmptyString(value, "entryType");
  if (
    entryType !== "attestation.created"
    && entryType !== "identity.created"
    && entryType !== "key.rotated"
    && entryType !== "checkpoint"
  ) {
    throw new Error("entryType is not a supported attestation ledger entry type");
  }
  return entryType;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return numberValue;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function normalizeTimestamp(value: string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const timestamp = requireNonEmptyString(value, "createdAt");
  if (!isValidAuditTimestamp(timestamp)) {
    throw new Error("createdAt must be an ISO 8601 timestamp");
  }
  return new Date(Date.parse(timestamp)).toISOString();
}
