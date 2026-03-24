import type { CreateIdentityInput, IdentityType, RelayAuthTokenClaims } from "@relayauth/types";
import { Hono } from "hono";
import type { IdentityBudget, StoredIdentity } from "../durable-objects/identity-do.js";
import type { AppEnv } from "../env.js";

type CreateIdentityRequest = CreateIdentityInput & {
  sponsorId?: string;
  budget?: IdentityBudget;
};

type JwtHeader = {
  alg?: string;
  typ?: string;
};

type DuplicateIdentityRow = {
  id?: string;
  name?: string;
  orgId?: string;
  org_id?: string;
  count?: number;
  exists?: number;
};

type OrgBudgetRow = {
  budget?: IdentityBudget;
  budget_json?: string;
  defaultBudget?: IdentityBudget;
  default_budget?: string;
  data?: string;
  settings_json?: string;
};

const identities = new Hono<AppEnv>();

const DUPLICATE_NAME_SQL = `
  SELECT id, name, org_id AS orgId
  FROM identities
  WHERE org_id = ? AND name = ?
  LIMIT 1
`;

const ORG_BUDGET_SQL = `
  SELECT budget, budget_json, default_budget, settings_json, data
  FROM org_budgets
  WHERE org_id = ?
  LIMIT 1
`;

identities.post("/", async (c) => {
  const auth = await authenticate(c.req.header("authorization"), c.env.SIGNING_KEY);
  if (!auth.ok) {
    return c.json({ error: auth.error }, 401);
  }

  const body = await c.req.json<CreateIdentityRequest>().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  const sponsorId = typeof body.sponsorId === "string" ? body.sponsorId.trim() : "";
  if (!sponsorId) {
    return c.json({ error: "sponsorId is required" }, 400);
  }

  const duplicate = await findDuplicateIdentity(c.env.DB, auth.claims.org, name);
  if (duplicate) {
    return c.json({ error: `Identity '${name}' already exists in this org` }, 409);
  }

  const timestamp = new Date().toISOString();
  const id = createIdentityId();
  const budget = body.budget ?? (await loadOrgBudget(c.env.DB, auth.claims.org));
  const storedIdentity: StoredIdentity = {
    id,
    name,
    type: normalizeIdentityType(body.type),
    orgId: auth.claims.org,
    status: "active",
    scopes: normalizeStringList(body.scopes),
    roles: normalizeStringList(body.roles),
    metadata: normalizeMetadata(body.metadata),
    createdAt: timestamp,
    updatedAt: timestamp,
    sponsorId,
    sponsorChain: [...auth.claims.sponsorChain, auth.claims.sub],
    workspaceId: normalizeWorkspaceId(body.workspaceId, auth.claims.wks),
    ...(budget ? { budget } : {}),
  };

  const durableObjectId = c.env.IDENTITY_DO.idFromName(storedIdentity.id);
  const durableObject = c.env.IDENTITY_DO.get(durableObjectId);
  const response = await durableObject.fetch(
    new Request("http://identity-do/internal/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(storedIdentity),
    }),
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    return c.json({ error: message || "Failed to create identity" }, response.status as 400 | 409 | 500);
  }

  const createdIdentity = await response.json<StoredIdentity>();
  return c.json(createdIdentity, 201);
});

async function authenticate(
  authorization: string | undefined,
  signingKey: string,
): Promise<
  | { ok: true; claims: RelayAuthTokenClaims }
  | { ok: false; error: string }
> {
  if (!authorization) {
    return { ok: false, error: "Missing Authorization header" };
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    return { ok: false, error: "Invalid Authorization header" };
  }

  const claims = await verifyToken(token, signingKey);
  if (!claims) {
    return { ok: false, error: "Invalid access token" };
  }

  return { ok: true, claims };
}

async function verifyToken(token: string, signingKey: string): Promise<RelayAuthTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<RelayAuthTokenClaims>(encodedPayload);
  if (!header || !payload || header.alg !== "HS256") {
    return null;
  }

  const isValidSignature = await verifyHs256Signature(
    `${encodedHeader}.${encodedPayload}`,
    signature,
    signingKey,
  );
  if (!isValidSignature) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return null;
  }

  if (
    typeof payload.sub !== "string" ||
    typeof payload.org !== "string" ||
    typeof payload.wks !== "string" ||
    typeof payload.sponsorId !== "string" ||
    !Array.isArray(payload.sponsorChain)
  ) {
    return null;
  }

  return payload;
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

async function verifyHs256Signature(
  value: string,
  signature: string,
  signingKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64UrlToBytes(signature),
      new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

function decodeBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function normalizeIdentityType(type: IdentityType | undefined): IdentityType {
  return type === "human" || type === "service" ? type : "agent";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
  );
}

function normalizeWorkspaceId(workspaceId: string | undefined, fallback: string): string {
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : fallback;
}

function createIdentityId(): string {
  return `agent_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function findDuplicateIdentity(
  db: D1Database,
  orgId: string,
  name: string,
): Promise<DuplicateIdentityRow | null> {
  return db.prepare(DUPLICATE_NAME_SQL).bind(orgId, name).first<DuplicateIdentityRow>();
}

async function loadOrgBudget(db: D1Database, orgId: string): Promise<IdentityBudget | undefined> {
  const row = await db.prepare(ORG_BUDGET_SQL).bind(orgId).first<OrgBudgetRow>();
  if (!row) {
    return undefined;
  }

  if (isIdentityBudget(row.budget)) {
    return row.budget;
  }

  if (isIdentityBudget(row.defaultBudget)) {
    return row.defaultBudget;
  }

  return (
    parseBudgetValue(row.budget_json) ??
    parseBudgetValue(row.default_budget) ??
    parseSettingsBudget(row.settings_json) ??
    parseBudgetValue(row.data)
  );
}

function parseSettingsBudget(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { budget?: unknown };
    return isIdentityBudget(parsed.budget) ? parsed.budget : undefined;
  } catch {
    return undefined;
  }
}

function parseBudgetValue(value: string | undefined): IdentityBudget | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isIdentityBudget(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isIdentityBudget(value: unknown): value is IdentityBudget {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export default identities;
