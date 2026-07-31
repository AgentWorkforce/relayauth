import type { AuditAction, AuditEntry } from "@relayauth/types";
import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import {
  createAuditQueryContinuationFilterKey,
  isValidAuditTimestamp,
  normalizeAuditArchiveCursorBoundaries,
  type AuditQueryCursor,
} from "../storage/interface.js";
import { requireScope } from "../middleware/scope.js";

export type ScopeContextVars = {
  identity?: {
    org: string;
  };
};

export type AuditLogRow = {
  id: string;
  action: AuditAction;
  identity_id: string;
  org_id: string;
  workspace_id: string | null;
  plane: string | null;
  resource: string | null;
  result: AuditEntry["result"];
  metadata_json: string | null;
  ip: string | null;
  user_agent: string | null;
  timestamp: string;
  created_at: string | null;
};

export type AuditEntryResponse = AuditEntry & {
  createdAt?: string;
};

export type AuditQueryParams = {
  orgId: string;
  identityId?: string;
  action?: AuditAction;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  cursor?: AuditQueryCursor;
  limit: number;
};

type ParseAuditQueryOptions = {
  defaultLimit?: number;
  maxLimit?: number;
};

type BuildAuditQueryOptions = {
  includeOverflowRow?: boolean;
};

const auditQuery = new Hono<AppEnv>();

export const AUDIT_ACTIONS = new Set<AuditAction>([
  "token.issued",
  "token.refreshed",
  "token.revoked",
  "token.validated",
  "identity.created",
  "identity.updated",
  "identity.suspended",
  "identity.retired",
  "scope.checked",
  "scope.denied",
  "role.assigned",
  "role.removed",
  "policy.created",
  "policy.updated",
  "policy.deleted",
  "key.rotated",
  "budget.exceeded",
  "budget.alert",
  "scope.escalation_denied",
]);

auditQuery.get("/", requireScope("relayauth:audit:read"), async (c) => {
  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const parsed = parseAuditQuery(c.req.query(), claims?.org);

  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const result = await c.get("storage").audit.query(parsed.value);
  if (result.kind === "budget_exhausted") {
    const nextCursor = encodeAuditCursor(result.continuation);
    if (!nextCursor) {
      return c.json({ error: "invalid audit continuation" }, 500);
    }
    return c.json(
      {
        entries: result.entries.slice(0, parsed.value.limit),
        nextCursor,
        hasMore: true,
        partial: true,
        workBudget: result.workBudget,
      },
      200,
    );
  }

  const entries = result.entries;
  const hasMore = entries.length > parsed.value.limit;
  const page = hasMore ? entries.slice(0, parsed.value.limit) : entries;
  const nextCursor = hasMore
    ? encodeAuditCursor({
        timestamp: page[page.length - 1]?.timestamp ?? "",
        id: page[page.length - 1]?.id ?? "",
      })
    : null;
  if (hasMore && !nextCursor) {
    return c.json({ error: "invalid audit continuation" }, 500);
  }

  return c.json(
    {
      entries: page,
      nextCursor,
      hasMore,
    },
    200,
  );
});

export function parseAuditQuery(
  query: Record<string, unknown>,
  authenticatedOrgId: string | undefined,
  options: ParseAuditQueryOptions = {},
): { ok: true; value: AuditQueryParams } | { ok: false; error: string } {
  const orgId = normalizeQueryValue(query.orgId);
  if (!orgId) {
    return { ok: false, error: "orgId query param is required" };
  }

  if (authenticatedOrgId && authenticatedOrgId !== orgId) {
    return { ok: false, error: "orgId does not match authenticated token" };
  }

  const action = normalizeQueryValue(query.action);
  if (action && !AUDIT_ACTIONS.has(action as AuditAction)) {
    return { ok: false, error: "invalid action" };
  }

  const result = normalizeQueryValue(query.result);
  if (result && result !== "allowed" && result !== "denied") {
    return { ok: false, error: "invalid result" };
  }

  const from = normalizeQueryValue(query.from);
  if (from && !isIsoTimestamp(from)) {
    return { ok: false, error: "from must be an ISO 8601 timestamp" };
  }

  const to = normalizeQueryValue(query.to);
  if (to && !isIsoTimestamp(to)) {
    return { ok: false, error: "to must be an ISO 8601 timestamp" };
  }

  const cursor = normalizeQueryValue(query.cursor);
  const decodedCursor = cursor ? decodeAuditCursor(cursor) : null;
  if (cursor && !decodedCursor) {
    return { ok: false, error: "invalid cursor" };
  }
  const limit = parseLimit(
    query.limit,
    options.defaultLimit ?? 50,
    options.maxLimit ?? 200,
  );
  if (limit === null) {
    return { ok: false, error: "limit must be a positive integer" };
  }

  const value: AuditQueryParams = {
    orgId,
    identityId: normalizeQueryValue(query.identityId),
    action: action as AuditAction | undefined,
    workspaceId: normalizeQueryValue(query.workspaceId),
    plane: normalizeQueryValue(query.plane),
    result: result as "allowed" | "denied" | undefined,
    from,
    to,
    cursor: decodedCursor ?? undefined,
    limit,
  };

  if (
    decodedCursor?.kind === "archive_partition" &&
    (decodedCursor.orgId !== orgId ||
      decodedCursor.filterKey !== createAuditQueryContinuationFilterKey(value))
  ) {
    return { ok: false, error: "invalid cursor" };
  }

  return {
    ok: true,
    value,
  };
}

export function buildAuditQuery(
  params: AuditQueryParams,
  options: BuildAuditQueryOptions = {},
): { sql: string; params: unknown[] } {
  const clauses = ["org_id = ?"];
  const values: unknown[] = [params.orgId];

  if (params.identityId) {
    clauses.push("identity_id = ?");
    values.push(params.identityId);
  }

  if (params.action) {
    clauses.push("action = ?");
    values.push(params.action);
  }

  if (params.workspaceId) {
    clauses.push("workspace_id = ?");
    values.push(params.workspaceId);
  }

  if (params.plane) {
    clauses.push("plane = ?");
    values.push(params.plane);
  }

  if (params.result) {
    clauses.push("result = ?");
    values.push(params.result);
  }

  if (params.from) {
    clauses.push("timestamp >= ?");
    values.push(params.from);
  }

  if (params.to) {
    clauses.push("(timestamp < ?)");
    values.push(params.to);
  }

  if (params.cursor?.kind === "archive_partition") {
    const boundaries = normalizeAuditArchiveCursorBoundaries(params.cursor);
    clauses.push("timestamp < ?");
    values.push(boundaries.upperBound);
    if (params.cursor.entryCursor) {
      clauses.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
      values.push(
        boundaries.entryCursorTimestamp,
        boundaries.entryCursorTimestamp,
        params.cursor.entryCursor.id,
      );
    }
  } else if (params.cursor) {
    clauses.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
    values.push(
      params.cursor.timestamp,
      params.cursor.timestamp,
      params.cursor.id,
    );
  }

  values.push(params.limit + ((options.includeOverflowRow ?? true) ? 1 : 0));

  return {
    sql: `
      SELECT id, action, identity_id, org_id, workspace_id, plane, resource,
             result, metadata_json, ip, user_agent, timestamp, created_at
      FROM audit_logs
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `,
    params: values,
  };
}

export function toAuditEntry(row: AuditLogRow): AuditEntryResponse {
  return {
    id: row.id,
    action: row.action,
    identityId: row.identity_id,
    orgId: row.org_id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.plane ? { plane: row.plane } : {}),
    ...(row.resource ? { resource: row.resource } : {}),
    result: row.result,
    ...(row.metadata_json
      ? { metadata: parseMetadata(row.metadata_json) }
      : {}),
    ...(row.ip ? { ip: row.ip } : {}),
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    timestamp: row.timestamp,
    ...(row.created_at ? { createdAt: row.created_at } : {}),
  };
}

export function parseMetadata(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const metadata: Record<string, string> = {};

    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === "string") {
        metadata[key] = entry;
      }
    }

    return metadata;
  } catch {
    return {};
  }
}

function normalizeQueryValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseLimit(
  value: unknown,
  defaultLimit: number,
  maxLimit: number,
): number | null {
  if (value === undefined) {
    return defaultLimit;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      return null;
    }

    return Math.min(value, maxLimit);
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return Math.min(parsed, maxLimit);
}

export function isIsoTimestamp(value: string): boolean {
  return isValidAuditTimestamp(value);
}

export function encodeAuditCursor(
  cursor: AuditQueryCursor | undefined,
): string | null {
  if (!cursor?.timestamp || !isIsoTimestamp(cursor.timestamp)) {
    return null;
  }

  if (cursor.kind === "archive_partition") {
    if (
      cursor.orgId.trim().length === 0 ||
      cursor.filterKey.length === 0 ||
      (cursor.entryCursor !== undefined &&
        (!isIsoTimestamp(cursor.entryCursor.timestamp) ||
          cursor.entryCursor.id.trim().length === 0))
    ) {
      return null;
    }
    return toBase64Url(
      JSON.stringify({
        version: 1,
        kind: cursor.kind,
        orgId: cursor.orgId,
        timestamp: cursor.timestamp,
        inclusive: cursor.inclusive === true,
        ...(cursor.chunk ? { chunk: cursor.chunk } : {}),
        ...(cursor.entryCursor ? { entryCursor: cursor.entryCursor } : {}),
        filterKey: cursor.filterKey,
      }),
    );
  }

  if (!cursor.id) {
    return null;
  }

  return toBase64Url(`${cursor.timestamp}|${cursor.id}`);
}

export function decodeAuditCursor(value: string): AuditQueryCursor | null {
  try {
    const decoded = fromBase64Url(value);
    const archiveCursor = parseArchiveCursor(decoded);
    if (archiveCursor) {
      return archiveCursor;
    }
    const separator = decoded.lastIndexOf("|");
    if (separator <= 0 || separator === decoded.length - 1) {
      return null;
    }

    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!isIsoTimestamp(timestamp) || id.trim().length === 0) {
      return null;
    }

    return { kind: "entry", timestamp, id };
  } catch {
    return null;
  }
}

function parseArchiveCursor(
  value: string,
): Extract<AuditQueryCursor, { kind: "archive_partition" }> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }
    const {
      version,
      kind,
      orgId,
      timestamp,
      inclusive,
      chunk,
      entryCursor,
      filterKey,
    } = parsed;
    return version === 1 &&
      kind === "archive_partition" &&
      typeof orgId === "string" &&
      orgId.length > 0 &&
      typeof timestamp === "string" &&
      isIsoTimestamp(timestamp) &&
      (inclusive === undefined || typeof inclusive === "boolean") &&
      (chunk === undefined ||
        (isRecord(chunk) &&
          typeof chunk.key === "string" &&
          chunk.key.length > 0 &&
          typeof chunk.sha256 === "string" &&
          chunk.sha256.length > 0)) &&
      (entryCursor === undefined ||
        (isRecord(entryCursor) &&
          typeof entryCursor.timestamp === "string" &&
          isIsoTimestamp(entryCursor.timestamp) &&
          typeof entryCursor.id === "string" &&
          entryCursor.id.length > 0)) &&
      typeof filterKey === "string" &&
      filterKey.length > 0
      ? {
          kind,
          orgId,
          timestamp,
          ...(inclusive === true ? { inclusive } : {}),
          ...(chunk
            ? {
                chunk: {
                  key: chunk.key as string,
                  sha256: chunk.sha256 as string,
                },
              }
            : {}),
          ...(entryCursor
            ? {
                entryCursor: {
                  timestamp: entryCursor.timestamp as string,
                  id: entryCursor.id as string,
                },
              }
            : {}),
          filterKey,
        }
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export default auditQuery;
