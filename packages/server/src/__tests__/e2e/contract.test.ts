import assert from "node:assert/strict";
import test from "node:test";

import { assertJsonResponse, createTestApp } from "../test-helpers.js";

type AuthMode = "public" | "bearer" | "apiKey" | "bearerOrApiKey";

type ResponseSchemaName =
  | "HealthResponse"
  | "JWKSResponse"
  | "TokenPair"
  | "ValidateTokenResponse"
  | "PaginatedTokenMetadataResponse"
  | "AgentIdentity"
  | "PaginatedIdentityResponse"
  | "CreateSubAgentResponse"
  | "BudgetResponse"
  | "ParsedScope"
  | "ScopeTemplatesResponse"
  | "CheckScopeResponse"
  | "Role"
  | "PaginatedRoleResponse"
  | "Policy"
  | "PaginatedPolicyResponse"
  | "EvaluatePolicyResponse"
  | "PaginatedAuditResponse"
  | "AuditEntry"
  | "SponsorChainResponse"
  | "ExportAuditResponse"
  | "ApiKeyCreateResponse"
  | "PaginatedApiKeyResponse"
  | "ApiKey"
  | "ListKeysResponse"
  | "RotateKeysResponse"
  | "OrgConfigResponse";

type FutureEndpointContract = {
  method: string;
  path: string;
  successStatus: number;
  auth: AuthMode;
  responseSchema?: ResponseSchemaName;
};

type OpenApiErrorResponse = {
  type: string;
  title: string;
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
};

const REQUIRED_FIELDS_BY_SCHEMA: Record<ResponseSchemaName, readonly string[]> = {
  HealthResponse: ["status", "version"],
  JWKSResponse: ["keys"],
  TokenPair: [
    "accessToken",
    "refreshToken",
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "tokenType",
  ],
  ValidateTokenResponse: ["valid", "claims"],
  PaginatedTokenMetadataResponse: ["data", "pagination"],
  AgentIdentity: [
    "id",
    "name",
    "type",
    "orgId",
    "status",
    "scopes",
    "roles",
    "metadata",
    "createdAt",
    "updatedAt",
  ],
  PaginatedIdentityResponse: ["data", "pagination"],
  CreateSubAgentResponse: ["identity", "tokenPair", "sponsorChain"],
  BudgetResponse: ["identityId"],
  ParsedScope: ["plane", "resource", "action", "path", "raw"],
  ScopeTemplatesResponse: ["templates"],
  CheckScopeResponse: ["allowed"],
  Role: ["id", "name", "description", "scopes", "orgId", "builtIn", "createdAt"],
  PaginatedRoleResponse: ["data", "pagination"],
  Policy: ["id", "name", "effect", "scopes", "conditions", "priority", "orgId", "createdAt"],
  PaginatedPolicyResponse: ["data", "pagination"],
  EvaluatePolicyResponse: ["result", "matchedPolicies"],
  PaginatedAuditResponse: ["data", "pagination"],
  AuditEntry: ["id", "action", "identityId", "orgId", "result", "timestamp"],
  SponsorChainResponse: ["chain"],
  ExportAuditResponse: ["exportId", "status"],
  ApiKeyCreateResponse: ["apiKey", "key"],
  PaginatedApiKeyResponse: ["data", "pagination"],
  ApiKey: ["id", "orgId", "prefix", "name", "scopes", "createdAt", "revoked"],
  ListKeysResponse: ["keys"],
  RotateKeysResponse: ["newKeyId", "oldKeyId", "rotatedAt"],
  OrgConfigResponse: [],
};

const FUTURE_ENDPOINT_CONTRACTS: FutureEndpointContract[] = [
  // OpenAPI path: /v1/health
  { method: "GET", path: "/v1/health", successStatus: 200, auth: "public", responseSchema: "HealthResponse" },

  // OpenAPI path: /.well-known/jwks.json
  { method: "GET", path: "/.well-known/jwks.json", successStatus: 200, auth: "public", responseSchema: "JWKSResponse" },

  // OpenAPI path: /v1/tokens
  { method: "POST", path: "/v1/tokens", successStatus: 201, auth: "apiKey", responseSchema: "TokenPair" },

  // OpenAPI path: /v1/tokens/refresh
  { method: "POST", path: "/v1/tokens/refresh", successStatus: 200, auth: "public", responseSchema: "TokenPair" },

  // OpenAPI path: /v1/tokens/revoke
  { method: "POST", path: "/v1/tokens/revoke", successStatus: 204, auth: "bearer" },

  // OpenAPI path: /v1/tokens/validate
  {
    method: "POST",
    path: "/v1/tokens/validate",
    successStatus: 200,
    auth: "bearerOrApiKey",
    responseSchema: "ValidateTokenResponse",
  },

  // OpenAPI path: /v1/tokens/{identityId}
  {
    method: "GET",
    path: "/v1/tokens/identity_test",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "PaginatedTokenMetadataResponse",
  },

  // OpenAPI path: /v1/identities
  { method: "POST", path: "/v1/identities", successStatus: 201, auth: "bearer", responseSchema: "AgentIdentity" },
  {
    method: "GET",
    path: "/v1/identities",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "PaginatedIdentityResponse",
  },

  // OpenAPI path: /v1/identities/{identityId}
  { method: "GET", path: "/v1/identities/identity_test", successStatus: 200, auth: "bearer", responseSchema: "AgentIdentity" },
  {
    method: "PATCH",
    path: "/v1/identities/identity_test",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "AgentIdentity",
  },
  { method: "DELETE", path: "/v1/identities/identity_test", successStatus: 204, auth: "bearer" },

  // OpenAPI path: /v1/identities/{identityId}/suspend
  {
    method: "POST",
    path: "/v1/identities/identity_test/suspend",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "AgentIdentity",
  },

  // OpenAPI path: /v1/identities/{identityId}/reactivate
  {
    method: "POST",
    path: "/v1/identities/identity_test/reactivate",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "AgentIdentity",
  },

  // OpenAPI path: /v1/identities/{identityId}/retire
  {
    method: "POST",
    path: "/v1/identities/identity_test/retire",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "AgentIdentity",
  },

  // OpenAPI path: /v1/identities/{identityId}/sub-agents
  {
    method: "POST",
    path: "/v1/identities/identity_test/sub-agents",
    successStatus: 201,
    auth: "bearer",
    responseSchema: "CreateSubAgentResponse",
  },
  {
    method: "GET",
    path: "/v1/identities/identity_test/sub-agents",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "PaginatedIdentityResponse",
  },

  // OpenAPI path: /v1/identities/{identityId}/budget
  {
    method: "GET",
    path: "/v1/identities/identity_test/budget",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "BudgetResponse",
  },
  {
    method: "PUT",
    path: "/v1/identities/identity_test/budget",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "BudgetResponse",
  },

  // OpenAPI path: /v1/scopes/validate
  { method: "POST", path: "/v1/scopes/validate", successStatus: 200, auth: "bearer", responseSchema: "ParsedScope" },

  // OpenAPI path: /v1/scopes/templates
  {
    method: "GET",
    path: "/v1/scopes/templates",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "ScopeTemplatesResponse",
  },

  // OpenAPI path: /v1/scopes/check
  { method: "POST", path: "/v1/scopes/check", successStatus: 200, auth: "bearer", responseSchema: "CheckScopeResponse" },

  // OpenAPI path: /v1/roles
  { method: "POST", path: "/v1/roles", successStatus: 201, auth: "bearer", responseSchema: "Role" },
  { method: "GET", path: "/v1/roles", successStatus: 200, auth: "bearer", responseSchema: "PaginatedRoleResponse" },

  // OpenAPI path: /v1/roles/{roleId}
  { method: "GET", path: "/v1/roles/role_test", successStatus: 200, auth: "bearer", responseSchema: "Role" },
  { method: "PATCH", path: "/v1/roles/role_test", successStatus: 200, auth: "bearer", responseSchema: "Role" },
  { method: "DELETE", path: "/v1/roles/role_test", successStatus: 204, auth: "bearer" },

  // OpenAPI path: /v1/roles/{roleId}/assign
  { method: "POST", path: "/v1/roles/role_test/assign", successStatus: 204, auth: "bearer" },

  // OpenAPI path: /v1/roles/{roleId}/unassign
  { method: "POST", path: "/v1/roles/role_test/unassign", successStatus: 204, auth: "bearer" },

  // OpenAPI path: /v1/policies
  { method: "POST", path: "/v1/policies", successStatus: 201, auth: "bearer", responseSchema: "Policy" },
  {
    method: "GET",
    path: "/v1/policies",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "PaginatedPolicyResponse",
  },

  // OpenAPI path: /v1/policies/{policyId}
  { method: "GET", path: "/v1/policies/policy_test", successStatus: 200, auth: "bearer", responseSchema: "Policy" },
  { method: "PATCH", path: "/v1/policies/policy_test", successStatus: 200, auth: "bearer", responseSchema: "Policy" },
  { method: "DELETE", path: "/v1/policies/policy_test", successStatus: 204, auth: "bearer" },

  // OpenAPI path: /v1/policies/evaluate
  {
    method: "POST",
    path: "/v1/policies/evaluate",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "EvaluatePolicyResponse",
  },

  // OpenAPI path: /v1/audit
  {
    method: "GET",
    path: "/v1/audit",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "PaginatedAuditResponse",
  },

  // OpenAPI path: /v1/audit/{entryId}
  { method: "GET", path: "/v1/audit/entry_test", successStatus: 200, auth: "bearer", responseSchema: "AuditEntry" },

  // OpenAPI path: /v1/audit/sponsor-chain/{identityId}
  {
    method: "GET",
    path: "/v1/audit/sponsor-chain/identity_test",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "SponsorChainResponse",
  },

  // OpenAPI path: /v1/audit/export
  {
    method: "POST",
    path: "/v1/audit/export",
    successStatus: 202,
    auth: "bearer",
    responseSchema: "ExportAuditResponse",
  },

  // OpenAPI path: /v1/audit/exports/{exportId}
  {
    method: "GET",
    path: "/v1/audit/exports/export_test",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "ExportAuditResponse",
  },

  // OpenAPI path: /v1/api-keys
  {
    method: "POST",
    path: "/v1/api-keys",
    successStatus: 201,
    auth: "bearer",
    responseSchema: "ApiKeyCreateResponse",
  },
  {
    method: "GET",
    path: "/v1/api-keys",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "PaginatedApiKeyResponse",
  },

  // OpenAPI path: /v1/api-keys/{apiKeyId}/revoke
  {
    method: "POST",
    path: "/v1/api-keys/api_key_test/revoke",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "ApiKey",
  },

  // OpenAPI path: /v1/admin/keys
  {
    method: "GET",
    path: "/v1/admin/keys",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "ListKeysResponse",
  },

  // OpenAPI path: /v1/admin/keys/rotate
  {
    method: "POST",
    path: "/v1/admin/keys/rotate",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "RotateKeysResponse",
  },

  // OpenAPI path: /v1/admin/org
  {
    method: "GET",
    path: "/v1/admin/org",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "OrgConfigResponse",
  },
  {
    method: "PATCH",
    path: "/v1/admin/org",
    successStatus: 200,
    auth: "bearer",
    responseSchema: "OrgConfigResponse",
  },
];

function assertRequiredFieldsPresent(
  body: unknown,
  requiredFields: readonly string[],
): asserts body is Record<string, unknown> {
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);

  const candidate = body as Record<string, unknown>;
  for (const field of requiredFields) {
    assert.ok(field in candidate, `expected response field '${field}' to be present`);
  }
}

function assertErrorResponseShape(
  body: unknown,
  expectedStatus?: number,
): asserts body is OpenApiErrorResponse {
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);

  const candidate = body as Record<string, unknown>;
  for (const field of ["type", "title", "status", "code", "message"]) {
    assert.ok(field in candidate, `expected error field '${field}' to be present`);
  }

  assert.equal(typeof candidate.type, "string");
  assert.equal(typeof candidate.title, "string");
  assert.equal(typeof candidate.status, "number");
  assert.equal(typeof candidate.code, "string");
  assert.equal(typeof candidate.message, "string");

  if (expectedStatus !== undefined) {
    assert.equal(candidate.status, expectedStatus);
  }

  if ("details" in candidate && candidate.details !== undefined) {
    assert.equal(typeof candidate.details, "object");
    assert.notEqual(candidate.details, null);
  }

  if ("requestId" in candidate && candidate.requestId !== undefined) {
    assert.equal(typeof candidate.requestId, "string");
  }
}

function buildRequestInit(method: string): RequestInit {
  if (method === "GET" || method === "DELETE") {
    return { method };
  }

  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  };
}

test("GET /health returns 200 with the current JSON contract", async () => {
  const app = createTestApp();
  const response = await app.request("/health");

  const body = await assertJsonResponse<{ status: string }>(response, 200);

  assert.deepEqual(body, { status: "ok" });
  assertRequiredFieldsPresent(body, ["status"]);
});

test.skip("GET /health matches the OpenAPI HealthResponse schema", async () => {
  // OpenAPI path: /health
  const app = createTestApp();
  const response = await app.request("/health");
  const body = await assertJsonResponse<Record<string, unknown>>(response, 200);

  assertRequiredFieldsPresent(body, REQUIRED_FIELDS_BY_SCHEMA.HealthResponse);
});

test.skip("OpenAPI error responses match the shared error schema", async () => {
  // OpenAPI components response: ErrorResponse
  const app = createTestApp();
  const response = await app.request("/v1/identities/missing");
  const body = await assertJsonResponse<OpenApiErrorResponse>(response, 404);

  assertErrorResponseShape(body, 404);
});

for (const endpoint of FUTURE_ENDPOINT_CONTRACTS) {
  test.skip(
    `${endpoint.method} ${endpoint.path} returns ${endpoint.successStatus} and matches its response contract`,
    async () => {
      const app = createTestApp();
      const response = await app.fetch(
        new Request(`http://localhost${endpoint.path}`, buildRequestInit(endpoint.method)),
      );

      assert.equal(response.status, endpoint.successStatus);

      if (!endpoint.responseSchema) {
        return;
      }

      const body = await assertJsonResponse<Record<string, unknown>>(
        response,
        endpoint.successStatus,
      );

      assertRequiredFieldsPresent(body, REQUIRED_FIELDS_BY_SCHEMA[endpoint.responseSchema]);
    },
  );

  if (endpoint.auth === "public") {
    continue;
  }

  test.skip(
    `${endpoint.method} ${endpoint.path} rejects requests without the required auth header`,
    async () => {
      const app = createTestApp();
      const response = await app.fetch(
        new Request(`http://localhost${endpoint.path}`, buildRequestInit(endpoint.method)),
      );

      const body = await assertJsonResponse<OpenApiErrorResponse>(response, 401);
      assertErrorResponseShape(body, 401);
    },
  );
}
