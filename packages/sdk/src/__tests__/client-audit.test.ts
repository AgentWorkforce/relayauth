import assert from "node:assert/strict";
import { test, onTestFinished } from "vitest";
import type { AuditEntry, AuditQuery } from "@relayauth/types";
import { RelayAuthClient } from "../client.js";

type IdentityActivityOptions = Omit<AuditQuery, "identityId" | "orgId">;

type AuditClient = RelayAuthClient & {
  queryAudit(query: AuditQuery): Promise<{ entries: AuditEntry[]; cursor?: string }>;
  getIdentityActivity(
    identityId: string,
    options?: IdentityActivityOptions,
  ): Promise<{ entries: AuditEntry[]; cursor?: string }>;
  exportAudit(query: AuditQuery, format: "json" | "csv"): Promise<string>;
};

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const token = "sdk_test_token";
const baseUrl = "https://relay.example.test";

const auditEntries: AuditEntry[] = [
  {
    id: "aud_002",
    action: "scope.denied",
    identityId: "agent_123",
    orgId: "org_123",
    workspaceId: "ws_123",
    plane: "relayauth",
    resource: "identity",
    result: "denied",
    metadata: { scope: "relayauth:identity:write" },
    ip: "203.0.113.42",
    userAgent: "relay-sdk-test/1.0",
    timestamp: "2026-03-25T10:05:00.000Z",
  },
  {
    id: "aud_001",
    action: "token.issued",
    identityId: "agent_123",
    orgId: "org_123",
    workspaceId: "ws_123",
    plane: "relayauth",
    resource: "token",
    result: "allowed",
    metadata: { audience: "relay-api" },
    ip: "203.0.113.41",
    userAgent: "relay-sdk-test/1.0",
    timestamp: "2026-03-25T10:00:00.000Z",
  },
];

function createClient(): AuditClient {
  return new RelayAuthClient({ baseUrl, token }) as AuditClient;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
    },
  });
}

function mockFetch(responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return responder(input, init);
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function inspectCall(call: FetchCall): Promise<{
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}> {
  const url =
    typeof call.input === "string"
      ? new URL(call.input)
      : call.input instanceof URL
        ? new URL(call.input.toString())
        : new URL(call.input.url);

  const method = call.init?.method ?? (call.input instanceof Request ? call.input.method : "GET");
  const headers = new Headers(call.input instanceof Request ? call.input.headers : undefined);
  if (call.init?.headers) {
    const overrideHeaders = new Headers(call.init.headers);
    for (const [name, value] of overrideHeaders.entries()) {
      headers.set(name, value);
    }
  }

  let body = "";
  if (call.init?.body != null) {
    body = await new Response(call.init.body).text();
  } else if (call.input instanceof Request) {
    body = await call.input.clone().text();
  }

  return { url, method, headers, body };
}

function assertBearer(headers: Headers): void {
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
}

test("queryAudit sends audit filters as query params and maps nextCursor to cursor", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse({
      entries: auditEntries,
      nextCursor: "cursor_next",
      hasMore: true,
    }),
  );
  onTestFinished(() => fetchMock.restore());

  const query: AuditQuery = {
    orgId: "org_123",
    identityId: "agent_123",
    action: "scope.denied",
    result: "denied",
    from: "2026-03-25T09:00:00.000Z",
    to: "2026-03-25T11:00:00.000Z",
    cursor: "cursor_start",
    limit: 50,
  };

  const result = await client.queryAudit(query);

  assert.deepEqual(result, {
    entries: auditEntries,
    cursor: "cursor_next",
  });
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/audit");
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.body, "");
  assert.equal(request.url.searchParams.get("orgId"), "org_123");
  assert.equal(request.url.searchParams.get("identityId"), "agent_123");
  assert.equal(request.url.searchParams.get("action"), "scope.denied");
  assert.equal(request.url.searchParams.get("result"), "denied");
  assert.equal(request.url.searchParams.get("from"), "2026-03-25T09:00:00.000Z");
  assert.equal(request.url.searchParams.get("to"), "2026-03-25T11:00:00.000Z");
  assert.equal(request.url.searchParams.get("cursor"), "cursor_start");
  assert.equal(request.url.searchParams.get("limit"), "50");
});

test("queryAudit returns an empty page when no audit entries match", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse({
      entries: [],
      nextCursor: null,
      hasMore: false,
    }),
  );
  onTestFinished(() => fetchMock.restore());

  const result = await client.queryAudit({
    orgId: "org_123",
    action: "token.issued",
  });

  assert.deepEqual(result, {
    entries: [],
  });
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/audit");
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.url.searchParams.get("orgId"), "org_123");
  assert.equal(request.url.searchParams.get("action"), "token.issued");
  assert.equal(request.url.searchParams.get("cursor"), null);
});

test("getIdentityActivity fetches a paginated activity feed with action and date-range filters", async () => {
  const client = createClient();
  const identityId = "agent/activity 123";
  const fetchMock = mockFetch(() =>
    jsonResponse({
      entries: [auditEntries[0]],
      nextCursor: "cursor_activity_next",
      hasMore: true,
      sponsorChain: ["user_123", "agent_root"],
      budgetUsage: {
        actionsThisHour: 4,
        costToday: 2,
        lastResetAt: "2026-03-25T00:00:00.000Z",
      },
      subAgents: [],
    }),
  );
  onTestFinished(() => fetchMock.restore());

  const result = await client.getIdentityActivity(identityId, {
    action: "scope.denied",
    result: "denied",
    from: "2026-03-25T09:00:00.000Z",
    to: "2026-03-25T11:00:00.000Z",
    cursor: "cursor_activity_start",
    limit: 25,
  });

  assert.deepEqual(result, {
    entries: [auditEntries[0]],
    cursor: "cursor_activity_next",
  });
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(
    request.url.pathname,
    `/v1/identities/${encodeURIComponent(identityId)}/activity`,
  );
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.body, "");
  assert.equal(request.url.searchParams.get("action"), "scope.denied");
  assert.equal(request.url.searchParams.get("result"), "denied");
  assert.equal(request.url.searchParams.get("from"), "2026-03-25T09:00:00.000Z");
  assert.equal(request.url.searchParams.get("to"), "2026-03-25T11:00:00.000Z");
  assert.equal(request.url.searchParams.get("cursor"), "cursor_activity_start");
  assert.equal(request.url.searchParams.get("limit"), "25");
  assert.equal(request.url.searchParams.get("identityId"), null);
  assert.equal(request.url.searchParams.get("orgId"), null);
});

test("exportAudit posts json export filters and returns the raw json payload", async () => {
  const client = createClient();
  const query: AuditQuery = {
    orgId: "org_123",
    identityId: "agent_123",
    action: "scope.denied",
    from: "2026-03-25T09:00:00.000Z",
    to: "2026-03-25T11:00:00.000Z",
    cursor: "cursor_export_start",
    limit: 100,
  };
  const exportPayload = JSON.stringify(auditEntries);
  const fetchMock = mockFetch(() => textResponse(exportPayload, 200, "application/json"));
  onTestFinished(() => fetchMock.restore());

  const result = await client.exportAudit(query, "json");

  assert.equal(result, exportPayload);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/audit/export");
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    ...query,
    format: "json",
  });
});

test("exportAudit returns raw csv data for csv exports", async () => {
  const client = createClient();
  const csvExport =
    "id,action,identityId,orgId,result,timestamp\n" +
    "aud_002,scope.denied,agent_123,org_123,denied,2026-03-25T10:05:00.000Z\n";
  const fetchMock = mockFetch(() => textResponse(csvExport, 200, "text/csv; charset=utf-8"));
  onTestFinished(() => fetchMock.restore());

  const result = await client.exportAudit(
    {
      orgId: "org_123",
      action: "scope.denied",
      identityId: "agent_123",
    },
    "csv",
  );

  assert.equal(result, csvExport);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/audit/export");
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    orgId: "org_123",
    action: "scope.denied",
    identityId: "agent_123",
    format: "csv",
  });
});
