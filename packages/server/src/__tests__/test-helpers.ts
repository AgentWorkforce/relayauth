import assert from "node:assert/strict";
import crypto from "node:crypto";
import type {
  AgentIdentity,
  AuditEntry,
  RelayAuthTokenClaims,
} from "@relayauth/types";
import type { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type {
  AuthStorage,
  AuditWebhookRecord,
  OrganizationContextRecord,
  WorkspaceContextRecord,
} from "../storage/index.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { IdentityBudget, StoredIdentity } from "../storage/identity-types.js";
import { createApp } from "../server.js";

type TestBindings = Pick<
  AppEnv["Bindings"],
  "INTERNAL_SECRET" | "RELAYAUTH_SIGNING_KEY_PEM" | "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC"
>;

type TestStorage = AuthStorage & Partial<ReturnType<typeof createSqliteStorage>>;

type TestApp = Hono<AppEnv> & {
  app: Hono<AppEnv>;
  bindings: TestBindings;
  storage: TestStorage;
  close(): Promise<void> | void;
};

type SqlTarget = TestApp | TestStorage;

type SeedAuditEntry = AuditEntry & {
  createdAt?: string;
};

type SeedAuditWebhook = AuditWebhookRecord & {
  createdAt?: string;
  updatedAt?: string;
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

const TEST_RSA_KEY_PAIR = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

export const TEST_RS256_PRIVATE_KEY_PEM = TEST_RSA_KEY_PAIR.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

export const TEST_RS256_PUBLIC_KEY_PEM = TEST_RSA_KEY_PAIR.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function signRs256(payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), TEST_RS256_PRIVATE_KEY_PEM)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

function resolveStorage(target: SqlTarget): TestStorage {
  return "storage" in target ? target.storage : target;
}

async function runSql(target: SqlTarget, query: string, ...params: unknown[]): Promise<void> {
  await resolveStorage(target).DB.prepare(query).bind(...params).run();
}

async function selectRows<T extends Record<string, unknown>>(
  target: SqlTarget,
  query: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await resolveStorage(target).DB.prepare(query).bind(...params).all<T>();
  return result.results;
}

export function createTestStorage(): TestStorage {
  return createSqliteStorage(":memory:");
}

export function generateTestToken(
  claims: Partial<RelayAuthTokenClaims> = {},
  _legacySecret = "dev-secret",
): string {
  const now = Math.floor(Date.now() / 1000);
  const sub = claims.sub ?? "agent_test";
  const sponsorId = claims.sponsorId ?? "user_test";
  const workspaceId = claims.workspace_id ?? claims.wks ?? "ws_test";
  const payload: RelayAuthTokenClaims = {
    sub,
    org: claims.org ?? "org_test",
    wks: claims.wks ?? workspaceId,
    workspace_id: workspaceId,
    agent_name: claims.agent_name ?? sub,
    scopes: claims.scopes ?? ["*"],
    sponsorId,
    sponsorChain: claims.sponsorChain ?? [sponsorId, sub],
    token_type: claims.token_type ?? "access",
    iss: claims.iss ?? "relayauth:test",
    aud: claims.aud ?? ["relayauth", "relayfile"],
    exp: claims.exp ?? now + 3600,
    iat: claims.iat ?? now,
    jti: claims.jti ?? crypto.randomUUID(),
    nbf: claims.nbf,
    sid: claims.sid,
    meta: claims.meta,
    parentTokenId: claims.parentTokenId,
    budget: claims.budget,
  };

  return signRs256(payload);
}

export function generateTestIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "agent_test",
    name: overrides.name ?? "Test Agent",
    type: overrides.type ?? "agent",
    orgId: overrides.orgId ?? "org_test",
    status: overrides.status ?? "active",
    scopes: overrides.scopes ?? ["*"],
    roles: overrides.roles ?? ["tester"],
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...(overrides.lastActiveAt !== undefined ? { lastActiveAt: overrides.lastActiveAt } : {}),
    ...(overrides.suspendedAt !== undefined ? { suspendedAt: overrides.suspendedAt } : {}),
    ...(overrides.suspendReason !== undefined ? { suspendReason: overrides.suspendReason } : {}),
  };
}

export async function assertJsonResponse<T>(
  response: Response,
  status: number,
  bodyCheck?: (body: T) => void | Promise<void>,
): Promise<T> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  const body = (await response.json()) as T;
  if (bodyCheck) {
    await bodyCheck(body);
  }
  return body;
}

export function createTestRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: HeadersInit = {},
): Request {
  const initHeaders = new Headers(headers);

  const hasBody = body !== undefined;
  const requestInit: RequestInit = {
    method,
    headers: initHeaders,
  };

  if (hasBody) {
    if (!initHeaders.has("Content-Type")) {
      initHeaders.set("Content-Type", "application/json");
    }
    requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return new Request(`http://localhost${path}`, requestInit);
}

export function mockKV(): KVNamespace {
  const values = new Map<string, string>();

  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    list: async () => ({
      keys: [...values.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
    getWithMetadata: async (key: string) => ({
      value: values.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

export function createTestApp(bindingsOverrides: Partial<TestBindings> = {}): TestApp {
  const storage = createTestStorage();
  const bindings: TestBindings = {
    INTERNAL_SECRET: bindingsOverrides.INTERNAL_SECRET ?? storage.INTERNAL_SECRET,
    RELAYAUTH_SIGNING_KEY_PEM:
      bindingsOverrides.RELAYAUTH_SIGNING_KEY_PEM ?? TEST_RS256_PRIVATE_KEY_PEM,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC:
      bindingsOverrides.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC ?? TEST_RS256_PUBLIC_KEY_PEM,
  };

  storage.INTERNAL_SECRET = bindings.INTERNAL_SECRET;

  const app = createApp({
    storage,
    defaultBindings: bindings,
  });

  const testApp = app as TestApp;
  testApp.app = app;
  testApp.bindings = bindings;
  testApp.storage = storage;
  testApp.close = () => storage.close();
  return testApp;
}

export async function seedStoredIdentity(
  target: SqlTarget,
  identity: StoredIdentity,
): Promise<StoredIdentity> {
  return resolveStorage(target).identities.create(identity);
}

export async function seedStoredIdentities(
  target: SqlTarget,
  identities: StoredIdentity[],
): Promise<StoredIdentity[]> {
  const seeded: StoredIdentity[] = [];
  for (const identity of identities) {
    seeded.push(await seedStoredIdentity(target, identity));
  }
  return seeded;
}

export async function seedAuditEntries(
  target: SqlTarget,
  entries: SeedAuditEntry[],
): Promise<void> {
  const storage = resolveStorage(target);

  for (const entry of entries) {
    await storage.audit.write(entry);
    if (entry.createdAt) {
      await runSql(
        storage,
        `
          UPDATE audit_logs
          SET created_at = ?
          WHERE id = ?
        `,
        entry.createdAt,
        entry.id,
      );
    }
  }
}

export async function seedOrgBudget(
  target: SqlTarget,
  orgId: string,
  budget: IdentityBudget,
): Promise<void> {
  const budgetJson = JSON.stringify(budget);
  await runSql(
    target,
    `
      INSERT INTO org_budgets (
        org_id,
        budget,
        budget_json,
        default_budget,
        settings_json,
        data
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    orgId,
    budgetJson,
    budgetJson,
    budgetJson,
    JSON.stringify({ budget }),
    budgetJson,
  );
}

export async function seedActiveTokens(
  target: SqlTarget,
  identityId: string,
  tokenIds: string[],
): Promise<void> {
  const timestamp = new Date().toISOString();

  for (const tokenId of tokenIds) {
    await runSql(
      target,
      `
        INSERT INTO tokens (id, token_id, jti, identity_id, status, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `,
      tokenId,
      tokenId,
      tokenId,
      identityId,
      timestamp,
    );
  }
}

export async function listRevokedTokenIds(target: SqlTarget): Promise<string[]> {
  const rows = await selectRows<{ jti?: string }>(
    target,
    `
      SELECT jti
      FROM revoked_tokens
      ORDER BY jti ASC
    `,
  );

  return rows
    .map((row) => row.jti)
    .filter((tokenId): tokenId is string => typeof tokenId === "string");
}

export async function seedAuditWebhooks(
  target: SqlTarget,
  webhooks: SeedAuditWebhook[],
): Promise<void> {
  for (const webhook of webhooks) {
    await runSql(
      target,
      `
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
      `,
      webhook.id,
      webhook.orgId,
      webhook.url,
      webhook.secret,
      webhook.events ? JSON.stringify(webhook.events) : null,
      webhook.createdAt ?? new Date().toISOString(),
      webhook.updatedAt ?? webhook.createdAt ?? new Date().toISOString(),
    );
  }
}

export async function seedOrganizationContext(
  target: SqlTarget,
  organization: OrganizationContextRecord,
): Promise<void> {
  await runSql(
    target,
    `
      INSERT INTO organizations (id, org_id, scopes_json, roles_json)
      VALUES (?, ?, ?, ?)
    `,
    organization.id,
    organization.orgId,
    JSON.stringify(organization.scopes),
    JSON.stringify(organization.roles),
  );
}

export async function seedWorkspaceContext(
  target: SqlTarget,
  workspace: WorkspaceContextRecord,
): Promise<void> {
  await runSql(
    target,
    `
      INSERT INTO workspaces (id, workspace_id, org_id, scopes_json, roles_json)
      VALUES (?, ?, ?, ?, ?)
    `,
    workspace.id,
    workspace.workspaceId,
    workspace.orgId,
    JSON.stringify(workspace.scopes),
    JSON.stringify(workspace.roles),
  );
}
