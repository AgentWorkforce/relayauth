import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { requireScope } from "../middleware/scope.js";
import {
  buildAuditQuery,
  parseAuditQuery,
  toAuditEntry,
  type AuditLogRow,
  type AuditEntryResponse,
  type ScopeContextVars,
} from "./audit-query.js";

type AuditExportRequest = {
  format?: unknown;
  orgId?: unknown;
  identityId?: unknown;
  action?: unknown;
  workspaceId?: unknown;
  plane?: unknown;
  result?: unknown;
  from?: unknown;
  to?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

const auditExport = new Hono<AppEnv>();

const CSV_HEADER = [
  "id",
  "action",
  "identityId",
  "orgId",
  "workspaceId",
  "plane",
  "resource",
  "result",
  "metadata",
  "ip",
  "userAgent",
  "timestamp",
  "createdAt",
].join(",");

auditExport.post("/export", requireScope("relayauth:audit:read"), async (c) => {
  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const body = await c.req.json<AuditExportRequest>().catch(() => null);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.format !== "json" && body.format !== "csv") {
    return c.json({ error: "format must be either json or csv" }, 400);
  }

  const parsed = parseAuditQuery(body, claims?.org, {
    defaultLimit: 10000,
    maxLimit: 10000,
  });

  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const query = buildAuditQuery(parsed.value, { includeOverflowRow: false });
  const result = await c.env.DB.prepare(query.sql)
    .bind(...query.params)
    .all<AuditLogRow>();
  const entries = (result.results ?? []).map(toAuditEntry);

  if (body.format === "json") {
    return c.json(entries, 200);
  }

  return new Response(toCsv(entries), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
    },
  });
});

function toCsv(entries: AuditEntryResponse[]): string {
  const lines = [CSV_HEADER, ...entries.map(toCsvRow)];
  return `${lines.join("\n")}\n`;
}

function toCsvRow(entry: AuditEntryResponse): string {
  const values = [
    entry.id,
    entry.action,
    entry.identityId,
    entry.orgId,
    entry.workspaceId ?? "",
    entry.plane ?? "",
    entry.resource ?? "",
    entry.result,
    entry.metadata ? JSON.stringify(entry.metadata) : "",
    entry.ip ?? "",
    entry.userAgent ?? "",
    entry.timestamp,
    entry.createdAt ?? "",
  ];

  return values.map(escapeCsvValue).join(",");
}

function escapeCsvValue(value: string): string {
  // Prevent CSV formula injection (CWE-1236)
  let sanitized = value;
  if (/^[=+\-@\t\r]/.test(sanitized)) {
    sanitized = `'${sanitized}`;
  }

  if (!/[",\n\r]/.test(sanitized)) {
    return sanitized;
  }

  return `"${sanitized.replace(/"/g, "\"\"")}"`;
}

export default auditExport;
