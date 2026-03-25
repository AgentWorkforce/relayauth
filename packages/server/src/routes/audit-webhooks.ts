import type { AuditAction } from "@relayauth/types";
import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import { requireScope } from "../middleware/scope.js";

type AuditWebhookEvent =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

type ScopeContextVars = {
  identity?: {
    org: string;
  };
};

type CreateAuditWebhookRequest = {
  orgId?: unknown;
  url?: unknown;
  events?: unknown;
  secret?: unknown;
};

type AuditWebhookRow = {
  id: string;
  org_id: string;
  url: string;
  secret: string;
  events_json: string | null;
  created_at: string;
  updated_at: string;
};

type AuditWebhookRecord = {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events?: string[];
  createdAt?: string;
  updatedAt?: string;
};

const auditWebhooks = new Hono<AppEnv>();

const AUDIT_WEBHOOK_EVENTS = new Set<AuditWebhookEvent>([
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

const CREATE_AUDIT_WEBHOOKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_webhooks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const CREATE_AUDIT_WEBHOOKS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_audit_webhooks_org_created
  ON audit_webhooks (org_id, created_at DESC, id DESC)
`;

const INSERT_AUDIT_WEBHOOK_SQL = `
  INSERT INTO audit_webhooks (
    id,
    org_id,
    url,
    secret,
    events_json,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const LIST_AUDIT_WEBHOOKS_SQL = `
  SELECT id, org_id, url, secret, events_json, created_at, updated_at
  FROM audit_webhooks
  WHERE org_id = ?
  ORDER BY created_at DESC, id DESC
`;

const DELETE_AUDIT_WEBHOOK_SQL = `
  DELETE FROM audit_webhooks
  WHERE org_id = ? AND id = ?
`;

auditWebhooks.use("*", requireScope("relayauth:audit:manage"));

auditWebhooks.post("/webhooks", async (c) => {
  await ensureAuditWebhookTable(c.env.DB);

  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const body = await c.req.json<CreateAuditWebhookRequest>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const orgId = normalizeRequiredString(body.orgId, "orgId");
  if (!orgId) {
    return c.json({ error: "orgId is required" }, 400);
  }

  if (!claims?.org || claims.org !== orgId) {
    return c.json({ error: "orgId does not match authenticated token" }, 403);
  }

  const url = normalizeRequiredString(body.url, "url");
  if (!url) {
    return c.json({ error: "url is required" }, 400);
  }

  if (!isValidWebhookUrl(url)) {
    return c.json({ error: "url must be a valid http or https URL" }, 400);
  }

  const secret = normalizeRequiredString(body.secret, "secret");
  if (!secret) {
    return c.json({ error: "secret is required" }, 400);
  }

  const events = parseAuditWebhookEvents(body.events);
  if (body.events !== undefined && events === null) {
    return c.json({ error: "events must be an array of valid audit actions" }, 400);
  }

  const timestamp = new Date().toISOString();
  const record: AuditWebhookRecord = {
    id: generateAuditWebhookId(),
    orgId,
    url,
    secret,
    ...(events && events.length > 0 ? { events } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await c.env.DB.prepare(INSERT_AUDIT_WEBHOOK_SQL)
    .bind(
      record.id,
      record.orgId,
      record.url,
      record.secret,
      record.events ? JSON.stringify(record.events) : null,
      record.createdAt,
      record.updatedAt,
    )
    .run();

  return c.json(maskSecret(record), 201);
});

auditWebhooks.get("/webhooks", async (c) => {
  await ensureAuditWebhookTable(c.env.DB);

  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const orgId = normalizeRequiredString(c.req.query("orgId"), "orgId");
  if (!orgId) {
    return c.json({ error: "orgId query param is required" }, 400);
  }

  if (!claims?.org || claims.org !== orgId) {
    return c.json({ error: "orgId does not match authenticated token" }, 403);
  }

  const result = await c.env.DB.prepare(LIST_AUDIT_WEBHOOKS_SQL).bind(orgId).all<AuditWebhookRow>();
  const records = (result.results ?? []).map(toAuditWebhookRecord).map(maskSecret);

  return c.json(records, 200);
});

auditWebhooks.delete("/webhooks/:id", async (c) => {
  await ensureAuditWebhookTable(c.env.DB);

  const claims = (c as typeof c & { var: ScopeContextVars }).var.identity;
  const orgId = normalizeRequiredString(c.req.query("orgId"), "orgId");
  if (!orgId) {
    return c.json({ error: "orgId query param is required" }, 400);
  }

  if (!claims?.org || claims.org !== orgId) {
    return c.json({ error: "orgId does not match authenticated token" }, 403);
  }

  const id = normalizeRequiredString(c.req.param("id"), "id");
  if (!id) {
    return c.json({ error: "id is required" }, 400);
  }

  await c.env.DB.prepare(DELETE_AUDIT_WEBHOOK_SQL).bind(orgId, id).run();
  return c.body(null, 204);
});

const initializedDbs = new WeakSet<D1Database>();

async function ensureAuditWebhookTable(db: D1Database): Promise<void> {
  if (initializedDbs.has(db)) return;
  await db.exec(CREATE_AUDIT_WEBHOOKS_TABLE_SQL);
  await db.exec(CREATE_AUDIT_WEBHOOKS_INDEX_SQL);
  initializedDbs.add(db);
}

function toAuditWebhookRecord(row: AuditWebhookRow): AuditWebhookRecord {
  const events = parseStoredEvents(row.events_json);

  return {
    id: row.id,
    orgId: row.org_id,
    url: row.url,
    secret: row.secret,
    ...(events && events.length > 0 ? { events } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskSecret(record: AuditWebhookRecord): AuditWebhookRecord {
  const secret = record.secret;
  const masked = secret.length > 8 ? "****" + secret.slice(-4) : "****";
  return { ...record, secret: masked };
}

function normalizeRequiredString(value: unknown, _field: string): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isValidWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }

    const hostname = url.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    ) {
      return false;
    }

    if (isPrivateIP(hostname)) {
      return false;
    }

    if (isCloudMetadataHost(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function isPrivateIP(hostname: string): boolean {
  const ipv6Bracket = hostname.match(/^\[(.+)\]$/);
  const raw = ipv6Bracket ? ipv6Bracket[1] : hostname;

  // Block IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  const ipv4Mapped = raw.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4Mapped) {
    return isPrivateIPv4(ipv4Mapped[1].split(".").map(Number));
  }

  // Parse IPv4 — reject octal (leading zeros) and decimal encoded IPs
  const parts = raw.split(".");
  if (parts.length === 4) {
    // Reject octal notation (e.g., 0177.0.0.1) and hex notation
    if (parts.some((p) => /^0\d/.test(p) || /^0x/i.test(p))) {
      return true;
    }
    const nums = parts.map(Number);
    if (nums.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      return isPrivateIPv4(nums);
    }
  }

  // Reject single decimal IP (e.g., 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(raw)) {
    const decimal = Number(raw);
    if (!isNaN(decimal) && decimal >= 0 && decimal <= 0xffffffff) {
      const a = (decimal >>> 24) & 0xff;
      const b = (decimal >>> 16) & 0xff;
      return isPrivateIPv4([a, b, (decimal >>> 8) & 0xff, decimal & 0xff]);
    }
  }

  if (raw.includes(":")) {
    const expanded = raw.toLowerCase();
    if (expanded === "::1" || expanded === "::") return true;
    if (expanded.startsWith("fe80")) return true;
    if (expanded.startsWith("fc") || expanded.startsWith("fd")) return true;
    if (expanded.startsWith("::ffff:")) return true;
  }

  return false;
}

function isPrivateIPv4(parts: number[]): boolean {
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 0) return true;
  return false;
}

function isCloudMetadataHost(hostname: string): boolean {
  const blocked = [
    "metadata.google.internal",
    "metadata.google.internal.",
    "169.254.169.254",
  ];
  return blocked.includes(hostname);
}

function parseAuditWebhookEvents(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const events: string[] = [];
  for (const entry of value) {
    const normalized = normalizeRequiredString(entry, "events");
    if (!normalized || !AUDIT_WEBHOOK_EVENTS.has(normalized as AuditWebhookEvent)) {
      return null;
    }
    events.push(normalized);
  }

  return Array.from(new Set(events));
}

function parseStoredEvents(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseStoredEvents(parsed);
  } catch {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}

function generateAuditWebhookId(): string {
  return `awh_${crypto.randomUUID()}`;
}

export default auditWebhooks;
