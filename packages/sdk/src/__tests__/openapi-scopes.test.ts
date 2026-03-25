import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../index.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

type OpenApiOperation = {
  summary?: string;
  "x-relayauth-scope"?: string;
};

type OpenApiSpec = {
  openapi: string;
  info: {
    title: string;
  };
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
};

type ScopeDefinition = {
  scope: string;
  description: string;
  method: string;
  path: string;
  approval: "session" | "explicit";
};

type OpenApiScopesApi = {
  generateScopes?: (spec: OpenApiSpec, serviceName?: string) => unknown;
};

function getOpenApiScopesApi(): Required<OpenApiScopesApi> {
  const api = sdk as OpenApiScopesApi;

  assert.equal(
    typeof api.generateScopes,
    "function",
    "sdk should export generateScopes",
  );

  return api as Required<OpenApiScopesApi>;
}

function createMinimalSpec(title = "User Directory API"): OpenApiSpec {
  return {
    openapi: "3.1.0",
    info: {
      title,
    },
    paths: {
      "/users": {
        get: {
          summary: "List users",
        },
        post: {
          summary: "Create user",
        },
      },
      "/users/{id}": {
        put: {
          summary: "Replace user",
        },
        delete: {
          summary: "Delete user",
        },
      },
      "/orgs/{id}/members": {
        get: {
          summary: "List org members",
        },
      },
    },
  };
}

function createOverrideSpec(): OpenApiSpec {
  return {
    openapi: "3.1.0",
    info: {
      title: "Audit Service",
    },
    paths: {
      "/audit/logs": {
        get: {
          summary: "Read audit logs",
          "x-relayauth-scope": "custom-admin:audit:read:*",
        },
      },
    },
  };
}

function toOperationMap(definitions: ScopeDefinition[]): Map<string, ScopeDefinition> {
  return new Map(
    definitions.map((definition) => [
      `${definition.method.toUpperCase()} ${definition.path}`,
      definition,
    ]),
  );
}

test("generateScopes(openapiSpec) parses a minimal OpenAPI spec", () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec());

  assert.ok(Array.isArray(definitions));
  assert.equal(definitions.length, 5);
});

test("generateScopes derives the service name from info.title using kebab-case", () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec("User Directory API")) as ScopeDefinition[];
  const operations = toOperationMap(definitions);

  assert.equal(operations.get("GET /users")?.scope, "user-directory-api:users:read");
});

test('generateScopes maps GET /users to "{service}:users:read"', () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec()) as ScopeDefinition[];
  const operation = toOperationMap(definitions).get("GET /users");

  assert.equal(operation?.scope, "user-directory-api:users:read");
  assert.equal(operation?.description, "List users");
  assert.equal(operation?.method, "GET");
  assert.equal(operation?.path, "/users");
  assert.equal(operation?.approval, "session");
});

test('generateScopes maps POST /users to "{service}:users:write"', () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec()) as ScopeDefinition[];
  const operation = toOperationMap(definitions).get("POST /users");

  assert.equal(operation?.scope, "user-directory-api:users:write");
  assert.equal(operation?.description, "Create user");
  assert.equal(operation?.method, "POST");
  assert.equal(operation?.path, "/users");
  assert.equal(operation?.approval, "explicit");
});

test('generateScopes maps PUT /users/{id} to "{service}:users:write:/users/{id}"', () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec()) as ScopeDefinition[];
  const operation = toOperationMap(definitions).get("PUT /users/{id}");

  assert.equal(operation?.scope, "user-directory-api:users:write:/users/{id}");
  assert.equal(operation?.description, "Replace user");
  assert.equal(operation?.method, "PUT");
  assert.equal(operation?.path, "/users/{id}");
  assert.equal(operation?.approval, "explicit");
});

test('generateScopes maps DELETE /users/{id} to "{service}:users:delete:/users/{id}"', () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec()) as ScopeDefinition[];
  const operation = toOperationMap(definitions).get("DELETE /users/{id}");

  assert.equal(operation?.scope, "user-directory-api:users:delete:/users/{id}");
  assert.equal(operation?.description, "Delete user");
  assert.equal(operation?.method, "DELETE");
  assert.equal(operation?.path, "/users/{id}");
  assert.equal(operation?.approval, "explicit");
});

test('generateScopes maps nested GET paths like /orgs/{id}/members to "{service}:orgs.members:read"', () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec()) as ScopeDefinition[];
  const operation = toOperationMap(definitions).get("GET /orgs/{id}/members");

  assert.equal(operation?.scope, "user-directory-api:orgs.members:read");
  assert.equal(operation?.description, "List org members");
  assert.equal(operation?.method, "GET");
  assert.equal(operation?.path, "/orgs/{id}/members");
  assert.equal(operation?.approval, "session");
});

test("generateScopes honors the x-relayauth-scope operation override", () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createOverrideSpec()) as ScopeDefinition[];

  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.scope, "custom-admin:audit:read:*");
  assert.equal(definitions[0]?.description, "Read audit logs");
  assert.equal(definitions[0]?.method, "GET");
  assert.equal(definitions[0]?.path, "/audit/logs");
});

test("generateScopes returns ScopeDefinition objects with descriptions from operation summaries", () => {
  const { generateScopes } = getOpenApiScopesApi();

  const definitions = generateScopes(createMinimalSpec()) as ScopeDefinition[];

  assert.deepEqual(
    definitions.map((definition) => definition.description).sort(),
    [
      "Create user",
      "Delete user",
      "List org members",
      "List users",
      "Replace user",
    ],
  );
});
