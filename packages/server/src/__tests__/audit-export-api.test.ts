import assert from "node:assert/strict";
import test from "node:test";
import type { AuditAction, AuditEntry } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
  seedAuditEntries,
} from "./test-helpers.js";

type AuditEntryExport = AuditEntry & {
  createdAt?: string;
};

type AuditExportRequest = {
  format: string;
  orgId: string;
  identityId?: string;
  action?: AuditAction;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  limit?: number;
};

function createAuditEntry(
  index: number,
  overrides: Partial<AuditEntryExport> = {},
): AuditEntryExport {
  const padded = String(index).padStart(5, "0");

  return {
    id: overrides.id ?? `aud_${padded}`,
    action: overrides.action ?? "token.validated",
    identityId: overrides.identityId ?? `agent_${padded}`,
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    plane: overrides.plane ?? "relayauth",
    resource: overrides.resource ?? `token:tok_${padded}`,
    result: overrides.result ?? "allowed",
    metadata: overrides.metadata ?? {
      sponsorId: "user_test",
      sponsorChain: JSON.stringify(["user_test", overrides.identityId ?? `agent_${padded}`]),
      requestId: `req_${padded}`,
    },
    ip: overrides.ip ?? "203.0.113.10",
    userAgent: overrides.userAgent ?? "audit-export-tests/1.0",
    timestamp: overrides.timestamp ?? new Date(Date.UTC(2026, 2, 24, 12, 0, index)).toISOString(),
    createdAt:
      overrides.createdAt ?? new Date(Date.UTC(2026, 2, 24, 12, 5, index)).toISOString(),
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (inQuotes) {
      if (character === "\"") {
        if (line[index + 1] === "\"") {
          current += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === ",") {
      values.push(current);
      current = "";
      continue;
    }

    if (character === "\"") {
      inQuotes = true;
      continue;
    }

    current += character;
  }

  values.push(current.replace(/\r$/, ""));
  return values;
}

async function postAuditExport(
  body: AuditExportRequest,
  {
    claims,
    entries = [],
    authorization,
  }: {
    claims?: Parameters<typeof generateTestToken>[0];
    entries?: AuditEntryExport[];
    authorization?: string;
  } = {},
): Promise<Response> {
  const app = createTestApp();
  await seedAuditEntries(app, entries);
  const token = authorization ?? `Bearer ${generateTestToken(claims)}`;
  const request = createTestRequest("POST", "/v1/audit/export", body, {
    Authorization: token,
  });

  return app.request(request, undefined, app.bindings);
}

test("POST /v1/audit/export with format=json returns JSON array", async () => {
  const entries: AuditEntryExport[] = [
    createAuditEntry(2, {
      id: "aud_export_json_002",
      orgId: "org_export_json",
      identityId: "agent_export_json_2",
      timestamp: "2026-03-24T12:00:02.000Z",
      createdAt: "2026-03-24T12:05:02.000Z",
    }),
    createAuditEntry(1, {
      id: "aud_export_json_001",
      orgId: "org_export_json",
      identityId: "agent_export_json_1",
      timestamp: "2026-03-24T12:00:01.000Z",
      createdAt: "2026-03-24T12:05:01.000Z",
    }),
  ];

  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_json",
    },
    {
      claims: {
        org: "org_export_json",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditEntryExport[]>(response, 200);

  assert.ok(Array.isArray(body));
  assert.deepEqual(body, entries);
});

test("POST /v1/audit/export with format=csv returns CSV with headers", async () => {
  const entry = createAuditEntry(1, {
    id: "aud_export_csv_001",
    orgId: "org_export_csv",
    timestamp: "2026-03-24T12:00:01.000Z",
    createdAt: "2026-03-24T12:05:01.000Z",
  });

  const response = await postAuditExport(
    {
      format: "csv",
      orgId: "org_export_csv",
    },
    {
      claims: {
        org: "org_export_csv",
        scopes: ["relayauth:audit:read"],
      },
      entries: [entry],
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/i);

  const text = await response.text();
  const lines = text.trimEnd().split(/\r?\n/);

  assert.equal(
    lines[0],
    "id,action,identityId,orgId,workspaceId,plane,resource,result,metadata,ip,userAgent,timestamp,createdAt",
  );
  assert.equal(lines.length, 2);
});

test("CSV export includes all AuditEntry fields as columns", async () => {
  const entry = createAuditEntry(1, {
    id: "aud_export_columns_001",
    action: "scope.denied",
    identityId: "agent_export_columns",
    orgId: "org_export_columns",
    workspaceId: "ws_export_columns",
    plane: "relayauth",
    resource: "token:tok_export_columns",
    result: "denied",
    metadata: {
      scope: "relayauth:audit:read",
      reason: "missing grant",
    },
    ip: "198.51.100.42",
    userAgent: "@relayauth/sdk/1.0.0",
    timestamp: "2026-03-24T12:00:01.000Z",
    createdAt: "2026-03-24T12:05:01.000Z",
  });

  const response = await postAuditExport(
    {
      format: "csv",
      orgId: "org_export_columns",
    },
    {
      claims: {
        org: "org_export_columns",
        scopes: ["relayauth:audit:read"],
      },
      entries: [entry],
    },
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  const [headerLine = "", rowLine = ""] = text.trimEnd().split(/\r?\n/);

  assert.deepEqual(parseCsvLine(headerLine), [
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
  ]);

  assert.deepEqual(parseCsvLine(rowLine), [
    "aud_export_columns_001",
    "scope.denied",
    "agent_export_columns",
    "org_export_columns",
    "ws_export_columns",
    "relayauth",
    "token:tok_export_columns",
    "denied",
    JSON.stringify(entry.metadata),
    "198.51.100.42",
    "'@relayauth/sdk/1.0.0",
    "2026-03-24T12:00:01.000Z",
    "2026-03-24T12:05:01.000Z",
  ]);
});

test("Export respects the same filters as the audit query API", async () => {
  const entries: AuditEntryExport[] = [
    createAuditEntry(1, {
      id: "aud_export_filters_match",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:00.000Z",
    }),
    createAuditEntry(2, {
      id: "aud_export_filters_identity",
      orgId: "org_export_filters",
      identityId: "agent_other",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:01.000Z",
    }),
    createAuditEntry(3, {
      id: "aud_export_filters_action",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "token.validated",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:02.000Z",
    }),
    createAuditEntry(4, {
      id: "aud_export_filters_workspace",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_other",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:03.000Z",
    }),
    createAuditEntry(5, {
      id: "aud_export_filters_plane",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relaycast",
      result: "denied",
      timestamp: "2026-03-24T11:00:04.000Z",
    }),
    createAuditEntry(6, {
      id: "aud_export_filters_result",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "allowed",
      timestamp: "2026-03-24T11:00:05.000Z",
    }),
    createAuditEntry(7, {
      id: "aud_export_filters_from",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T09:59:59.999Z",
    }),
    createAuditEntry(8, {
      id: "aud_export_filters_to",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T12:00:00.000Z",
    }),
    createAuditEntry(9, {
      id: "aud_export_filters_org",
      orgId: "org_other",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      timestamp: "2026-03-24T11:00:06.000Z",
    }),
  ];

  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_filters",
      identityId: "agent_target",
      action: "scope.denied",
      workspaceId: "ws_target",
      plane: "relayauth",
      result: "denied",
      from: "2026-03-24T10:00:00.000Z",
      to: "2026-03-24T12:00:00.000Z",
    },
    {
      claims: {
        org: "org_export_filters",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditEntryExport[]>(response, 200);

  assert.deepEqual(
    body.map((entry) => entry.id),
    ["aud_export_filters_match"],
  );
});

test("Export has a max row limit of 10000", async () => {
  const entries = Array.from({ length: 10050 }, (_, index) =>
    createAuditEntry(index + 1, {
      orgId: "org_export_limit",
    }),
  );

  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_limit",
      limit: 20000,
    },
    {
      claims: {
        org: "org_export_limit",
        scopes: ["relayauth:audit:read"],
      },
      entries,
    },
  );
  const body = await assertJsonResponse<AuditEntryExport[]>(response, 200);

  assert.equal(body.length, 10000);
  assert.equal(body[0]?.id, "aud_10050");
  assert.equal(body.at(-1)?.id, "aud_00051");
});

test("POST /v1/audit/export returns 401 without valid auth token", async () => {
  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_auth_failure",
    },
    {
      authorization: "Bearer definitely-not-a-valid-token",
    },
  );

  assert.equal(response.status, 401);
});

test("POST /v1/audit/export returns 403 without relayauth:audit:read scope", async () => {
  const response = await postAuditExport(
    {
      format: "json",
      orgId: "org_export_scope_failure",
    },
    {
      claims: {
        org: "org_export_scope_failure",
        scopes: ["relayauth:identity:read:*"],
      },
    },
  );

  assert.equal(response.status, 403);
});

test("POST /v1/audit/export returns 400 for invalid format parameter", async () => {
  const response = await postAuditExport(
    {
      format: "xml",
      orgId: "org_export_invalid_format",
    },
    {
      claims: {
        org: "org_export_invalid_format",
        scopes: ["relayauth:audit:read"],
      },
    },
  );
  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.match(body.error, /format/i);
});
