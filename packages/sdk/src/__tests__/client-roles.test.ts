import assert from "node:assert/strict";
import { test, onTestFinished } from "vitest";
import type { Role } from "@relayauth/types";
import { RelayAuthClient } from "../client.js";
import { RelayAuthError } from "../errors.js";

type CreateRoleInput = {
  name: string;
  description: string;
  scopes: string[];
  workspaceId?: string;
};

type UpdateRoleInput = Partial<CreateRoleInput>;

type RoleClient = RelayAuthClient & {
  createRole(orgId: string, input: CreateRoleInput): Promise<Role>;
  getRole(roleId: string): Promise<Role>;
  listRoles(orgId: string): Promise<Role[]>;
  updateRole(roleId: string, updates: UpdateRoleInput): Promise<Role>;
  deleteRole(roleId: string): Promise<void>;
  assignRole(identityId: string, roleId: string): Promise<void>;
  removeRole(identityId: string, roleId: string): Promise<void>;
};

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const token = "sdk_test_token";
const baseUrl = "https://relay.example.test";

const role: Role = {
  id: "role_123",
  name: "incident-reviewer",
  description: "Can review incident channels and audits",
  scopes: ["relayauth:audit:read:*", "relaycast:channel:read:#incidents"],
  orgId: "org_123",
  workspaceId: "ws_123",
  builtIn: false,
  createdAt: "2026-03-25T10:00:00.000Z",
};

const secondRole: Role = {
  id: "role_456",
  name: "prod-observer",
  description: "Read-only access to production operations",
  scopes: ["cloud:workflow:read:prod-*"],
  orgId: "org_123",
  builtIn: false,
  createdAt: "2026-03-25T11:00:00.000Z",
};

function createClient(): RoleClient {
  return new RelayAuthClient({ baseUrl, token }) as RoleClient;
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

test("createRole posts to /v1/roles with orgId in the JSON body", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(role, 201));
  onTestFinished(() => fetchMock.restore());

  const input: CreateRoleInput = {
    name: "incident-reviewer",
    description: "Can review incident channels and audits",
    scopes: ["relayauth:audit:read:*", "relaycast:channel:read:#incidents"],
    workspaceId: "ws_123",
  };

  const created = await client.createRole("org_123", input);

  assert.deepEqual(created, role);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/roles`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    orgId: "org_123",
    ...input,
  });
});

test("getRole fetches /v1/roles/:id with bearer auth", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => jsonResponse(role));
  onTestFinished(() => fetchMock.restore());

  const result = await client.getRole(role.id);

  assert.deepEqual(result, role);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/roles/${role.id}`);
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("listRoles sends orgId as a query param and maps data to a role array", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse({
      data: [role, secondRole],
    }),
  );
  onTestFinished(() => fetchMock.restore());

  const result = await client.listRoles("org_123");

  assert.deepEqual(result, [role, secondRole]);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.pathname, "/v1/roles");
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
  assert.equal(request.url.searchParams.get("orgId"), "org_123");
  assert.equal(request.body, "");
});

test("updateRole patches /v1/roles/:id with JSON updates", async () => {
  const client = createClient();
  const updatedRole: Role = {
    ...role,
    description: "Can review incidents and production audit logs",
    scopes: [...role.scopes, "cloud:workflow:read:prod-*"],
  };
  const fetchMock = mockFetch(() => jsonResponse(updatedRole));
  onTestFinished(() => fetchMock.restore());

  const updates: UpdateRoleInput = {
    description: "Can review incidents and production audit logs",
    scopes: [...role.scopes, "cloud:workflow:read:prod-*"],
  };

  const result = await client.updateRole(role.id, updates);

  assert.deepEqual(result, updatedRole);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/roles/${role.id}`);
  assert.equal(request.method, "PATCH");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), updates);
});

test("deleteRole deletes /v1/roles/:id and returns void", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
  onTestFinished(() => fetchMock.restore());

  const result = await client.deleteRole(role.id);

  assert.equal(result, undefined);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/roles/${role.id}`);
  assert.equal(request.method, "DELETE");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("assignRole posts roleId to /v1/identities/:id/roles", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
  onTestFinished(() => fetchMock.restore());

  const result = await client.assignRole("agent_123", role.id);

  assert.equal(result, undefined);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/agent_123/roles`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    roleId: role.id,
  });
});

test("removeRole deletes /v1/identities/:id/roles/:roleId", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
  onTestFinished(() => fetchMock.restore());

  const result = await client.removeRole("agent_123", role.id);

  assert.equal(result, undefined);
  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/identities/agent_123/roles/${role.id}`);
  assert.equal(request.method, "DELETE");
  assertBearer(request.headers);
  assert.equal(request.body, "");
});

test("getRole maps a 404 role_not_found response to RelayAuthError", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "role_not_found",
        message: "Role not found: role_missing_404",
      },
      404,
    ),
  );
  onTestFinished(() => fetchMock.restore());

  await assert.rejects(
    () => client.getRole("role_missing_404"),
    (error: unknown) => {
      assert.ok(error instanceof RelayAuthError);
      assert.equal(error.code, "role_not_found");
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, "Role not found: role_missing_404");
      return true;
    },
  );

  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/roles/role_missing_404`);
  assert.equal(request.method, "GET");
  assertBearer(request.headers);
});

test("createRole surfaces duplicate role name conflicts as RelayAuthError", async () => {
  const client = createClient();
  const fetchMock = mockFetch(() =>
    jsonResponse(
      {
        error: "role_name_conflict",
        message: "Role 'incident-reviewer' already exists in this org",
      },
      409,
    ),
  );
  onTestFinished(() => fetchMock.restore());

  await assert.rejects(
    () =>
      client.createRole("org_123", {
        name: "incident-reviewer",
        description: "Duplicate role attempt",
        scopes: ["relayauth:audit:read:*"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof RelayAuthError);
      assert.equal(error.code, "role_name_conflict");
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, "Role 'incident-reviewer' already exists in this org");
      return true;
    },
  );

  assert.equal(fetchMock.calls.length, 1);

  const request = await inspectCall(fetchMock.calls[0]);
  assert.equal(request.url.toString(), `${baseUrl}/v1/roles`);
  assert.equal(request.method, "POST");
  assertBearer(request.headers);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    orgId: "org_123",
    name: "incident-reviewer",
    description: "Duplicate role attempt",
    scopes: ["relayauth:audit:read:*"],
  });
});
