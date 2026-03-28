import assert from "node:assert/strict";
import { test, onTestFinished } from "vitest";
import type { AgentIdentity, CreateIdentityInput, IdentityStatus } from "@relayauth/types";
import { RelayAuthClient } from "../client.js";
import { IdentityNotFoundError, IdentitySuspendedError } from "../errors.js";

type IdentityClient = RelayAuthClient & {
  createIdentity(orgId: string, input: CreateIdentityInput): Promise<AgentIdentity>;
  getIdentity(identityId: string): Promise<AgentIdentity>;
  listIdentities(
    orgId: string,
    options?: { limit?: number; cursor?: string; status?: IdentityStatus },
  ): Promise<{ identities: AgentIdentity[]; cursor?: string }>;
  updateIdentity(identityId: string, updates: Partial<CreateIdentityInput>): Promise<AgentIdentity>;
  suspendIdentity(identityId: string, reason: string): Promise<AgentIdentity>;
  reactivateIdentity(identityId: string): Promise<AgentIdentity>;
  retireIdentity(identityId: string): Promise<AgentIdentity>;
  deleteIdentity(identityId: string): Promise<void>;
};

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const token = "sdk_test_token";
const baseUrl = "https://relay.example.test";

const identity: AgentIdentity = {
  id: "agent_123",
  name: "billing-bot",
  type: "agent",
  orgId: "org_123",
  status: "active",
  scopes: ["relayauth:identity:read"],
  roles: ["role_admin"],
  metadata: { team: "ops" },
  createdAt: "2026-03-25T10:00:00.000Z",
  updatedAt: "2026-03-25T10:00:00.000Z",
};

function createClient(): IdentityClient {
  return new RelayAuthClient({ baseUrl, token }) as IdentityClient;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
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

test("createIdentity posts to /v1/identities with orgId in the JSON body", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(identity, 201));
  onTestFinished(() => fetchMock.restore());

  const input: CreateIdentityInput = {
    name: "billing-bot",
    type: "service",
    scopes: ["relayauth:identity:read"],
    roles: ["role_admin"],
    metadata: { team: "ops" },
    workspaceId: "ws_123",
  };

  const created = await client.createIdentity("org_123", input);

  assert.deepEqual(created, identity);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    orgId: "org_123",
    ...input,
  });
});

test("getIdentity fetches /v1/identities/:id with bearer auth", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(identity));
  onTestFinished(() => fetchMock.restore());

  const result = await client.getIdentity(identity.id);

  assert.deepEqual(result, identity);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/${identity.id}`);
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("listIdentities sends orgId and filters as query params and maps data to identities", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse({
      data: [identity],
      cursor: "cursor_next",
    }),
  );
  onTestFinished(() => fetchMock.restore());

  const result = await client.listIdentities("org_123", {
    limit: 25,
    cursor: "cursor_start",
    status: "suspended",
  });

  assert.deepEqual(result, {
    identities: [identity],
    cursor: "cursor_next",
  });
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/identities");
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.url.searchParams.get("orgId"), "org_123");
  assert.equal(request.url.searchParams.get("limit"), "25");
  assert.equal(request.url.searchParams.get("cursor"), "cursor_start");
  assert.equal(request.url.searchParams.get("status"), "suspended");
  assert.equal(request.body, "");
});

test("updateIdentity patches /v1/identities/:id with JSON updates", async () => {
  const client = createClient();
  const updatedIdentity: AgentIdentity = {
    ...identity,
    name: "billing-bot-v2",
    roles: ["role_admin", "role_writer"],
    metadata: { team: "platform" },
    updatedAt: "2026-03-25T11:00:00.000Z",
  };
  const fetchMock = mockFetch(() => jsonResponse(updatedIdentity));
  onTestFinished(() => fetchMock.restore());

  const updates: Partial<CreateIdentityInput> = {
    name: "billing-bot-v2",
    roles: ["role_admin", "role_writer"],
    metadata: { team: "platform" },
  };

  const result = await client.updateIdentity(identity.id, updates);

  assert.deepEqual(result, updatedIdentity);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/${identity.id}`);
  assert.equal(request.method, "PATCH");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), updates);
});

test("suspendIdentity posts reason to /v1/identities/:id/suspend", async () => {
  const client = createClient();
  const suspendedIdentity: AgentIdentity = {
    ...identity,
    status: "suspended",
    suspendedAt: "2026-03-25T12:00:00.000Z",
    suspendReason: "policy_violation",
    updatedAt: "2026-03-25T12:00:00.000Z",
  };
  const fetchMock = mockFetch(() => jsonResponse(suspendedIdentity));
  onTestFinished(() => fetchMock.restore());

  const result = await client.suspendIdentity(identity.id, "policy_violation");

  assert.deepEqual(result, suspendedIdentity);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/${identity.id}/suspend`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), { reason: "policy_violation" });
});

test("reactivateIdentity posts to /v1/identities/:id/reactivate", async () => {
  const client = createClient();
  const reactivatedIdentity: AgentIdentity = {
    ...identity,
    status: "active",
    updatedAt: "2026-03-25T13:00:00.000Z",
  };
  const fetchMock = mockFetch(() => jsonResponse(reactivatedIdentity));
  onTestFinished(() => fetchMock.restore());

  const result = await client.reactivateIdentity(identity.id);

  assert.deepEqual(result, reactivatedIdentity);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/${identity.id}/reactivate`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("retireIdentity posts to /v1/identities/:id/retire", async () => {
  const client = createClient();
  const retiredIdentity: AgentIdentity = {
    ...identity,
    status: "retired",
    updatedAt: "2026-03-25T14:00:00.000Z",
  };
  const fetchMock = mockFetch(() => jsonResponse(retiredIdentity));
  onTestFinished(() => fetchMock.restore());

  const result = await client.retireIdentity(identity.id);

  assert.deepEqual(result, retiredIdentity);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/${identity.id}/retire`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("deleteIdentity sends DELETE with confirmation header", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
  onTestFinished(() => fetchMock.restore());

  await client.deleteIdentity(identity.id);

  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/${identity.id}`);
  assert.equal(request.method, "DELETE");
  assertBearer(request.headers);
  assert.equal(request.headers.get("x-confirm-delete"), "true");
  assert.equal(request.body, "");
});

test("maps 404 responses to IdentityNotFoundError", async () => {
  const client = createClient();
  const missingIdentityId = "agent_missing";
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "identity_not_found",
      },
      404,
    ),
  );
  onTestFinished(() => fetchMock.restore());

  await assert.rejects(
    client.getIdentity(missingIdentityId),
    (error: unknown) => {
      assert.ok(error instanceof IdentityNotFoundError);
      assert.equal(error.message, `Identity not found: ${missingIdentityId}`);
      assert.equal(error.code, "identity_not_found");
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("maps 403 responses to IdentitySuspendedError", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "identity_suspended",
      },
      403,
    ),
  );
  onTestFinished(() => fetchMock.restore());

  await assert.rejects(
    client.updateIdentity(identity.id, { metadata: { team: "security" } }),
    (error: unknown) => {
      assert.ok(error instanceof IdentitySuspendedError);
      assert.equal(error.message, `Identity suspended: ${identity.id}`);
      assert.equal(error.code, "identity_suspended");
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});
