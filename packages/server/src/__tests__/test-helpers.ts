import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AgentIdentity, RelayAuthTokenClaims } from "@relayauth/types";
import type { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createCloudflareStorage, type AuthStorage } from "../storage/index.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import { createApp } from "../worker.js";

type TestBindings = AppEnv["Bindings"] & {
  IDENTITY_DO: DurableObjectNamespace;
  DB: D1Database;
  REVOCATION_KV: KVNamespace;
};

type TestStorage = AuthStorage & Partial<ReturnType<typeof createSqliteStorage>>;

type TestApp = Hono<AppEnv> & {
  app: Hono<AppEnv>;
  bindings: TestBindings;
  storage: TestStorage;
  close(): Promise<void> | void;
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

export function mockD1(): D1Database {
  const rows = new Map<string, unknown[]>();

  const createPreparedStatement = (query: string) => {
    const key = query.trim();
    return {
      bind: (...params: unknown[]) => {
        const boundKey = `${key}::${JSON.stringify(params)}`;
        return {
          first: async <T>() => (rows.get(boundKey)?.[0] as T | null) ?? null,
          run: async () => ({
            success: true,
            meta: { changed_db: false, changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
          }),
          raw: async <T>() => (rows.get(boundKey) as T[]) ?? [],
          all: async <T>() => ({
            results: (rows.get(boundKey) as T[]) ?? [],
            success: true,
            meta: { changed_db: false, changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
          }),
        };
      },
      first: async <T>() => (rows.get(key)?.[0] as T | null) ?? null,
      run: async () => ({
        success: true,
        meta: { changed_db: false, changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
      }),
      raw: async <T>() => (rows.get(key) as T[]) ?? [],
      all: async <T>() => ({
        results: (rows.get(key) as T[]) ?? [],
        success: true,
        meta: { changed_db: false, changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
      }),
    };
  };

  return {
    prepare: (query: string) => createPreparedStatement(query),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({
      count: 0,
      duration: 0,
    }),
    dump: async () => new ArrayBuffer(0),
    __seed(query: string, result: unknown[]) {
      rows.set(query.trim(), result);
    },
  } as D1Database;
}

export function mockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as KVNamespace;
}

export function mockDO(
  response?: Response | ((request: Request) => Response | Promise<Response>),
): DurableObjectNamespace {
  const stub = {
    fetch: async (request: Request) => {
      if (typeof response === "function") {
        return response(request);
      }
      return response ?? new Response(null, { status: 200 });
    },
  };

  return {
    idFromName: (name: string) => `${name}-id`,
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

export function generateTestToken(
  claims: Partial<RelayAuthTokenClaims> = {},
  secret = "dev-secret",
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

  return signHs256(payload, secret);
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

export function createTestApp(bindingsOverrides: Partial<TestBindings> = {}): TestApp {
  const sqliteStorage = createSqliteStorage(":memory:");
  const bindings: TestBindings = {
    IDENTITY_DO: sqliteStorage.IDENTITY_DO,
    DB: sqliteStorage.DB,
    REVOCATION_KV: sqliteStorage.REVOCATION_KV,
    SIGNING_KEY: "dev-secret",
    SIGNING_KEY_ID: "dev-key",
    INTERNAL_SECRET: sqliteStorage.INTERNAL_SECRET,
    ...bindingsOverrides,
  };

  const hasCustomCloudflareBindings =
    bindingsOverrides.DB !== undefined
    || bindingsOverrides.IDENTITY_DO !== undefined
    || bindingsOverrides.REVOCATION_KV !== undefined;

  let storage: TestStorage;

  if (hasCustomCloudflareBindings) {
    storage = createCloudflareStorage({
      DB: bindings.DB,
      IDENTITY_DO: bindings.IDENTITY_DO,
      REVOCATION_KV: bindings.REVOCATION_KV,
      INTERNAL_SECRET: bindings.INTERNAL_SECRET,
    });
  } else {
    sqliteStorage.SIGNING_KEY = bindings.SIGNING_KEY;
    sqliteStorage.SIGNING_KEY_ID = bindings.SIGNING_KEY_ID;
    sqliteStorage.INTERNAL_SECRET = bindings.INTERNAL_SECRET;
    storage = sqliteStorage;
  }

  const app = createApp({
    defaultBindings: bindings,
    storage,
  });

  const testApp = app as TestApp;
  testApp.app = app;
  testApp.bindings = bindings;
  testApp.storage = storage;
  testApp.close = () => sqliteStorage.close();
  return testApp;
}
