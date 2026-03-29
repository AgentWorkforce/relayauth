import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfiguration } from "@relayauth/types";
import {
  agentCardToConfiguration,
  assertValidA2aAgentCard,
  configurationToAgentCard,
  type A2aAgentCard,
} from "../a2a-bridge.js";

function buildConfiguration(overrides: Partial<AgentConfiguration> = {}): AgentConfiguration {
  return {
    schema_version: "1.0",
    issuer: "https://relayauth.example.com",
    service_name: "relayauth",
    server_version: "0.0.0",
    documentation_url: "https://docs.relayauth.example.com",
    jwks_uri: "https://relayauth.example.com/.well-known/jwks.json",
    token_endpoint: "https://relayauth.example.com/v1/tokens",
    identity_endpoint: "https://relayauth.example.com/v1/identities",
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_post"],
    token_signing_alg_values_supported: ["RS256"],
    scope_format: {
      pattern: "{plane}:{resource}:{action}:{path?}",
      separator: ":",
      path_optional: true,
      wildcard: "*",
      planes: ["relayauth"],
      actions: ["invoke"],
    },
    scope_definitions: [
      {
        name: "relayauth-identity",
        plane: "relayauth",
        resource: "identity",
        pattern: "relayauth:identity:manage:*",
        actions: ["read", "manage"],
        path_schema: {
          type: "identifier",
          required: false,
          wildcard_allowed: true,
          description: "Identity selector.",
          examples: ["*"],
        },
        description: "Identity administration.",
        examples: ["relayauth:identity:manage:*"],
      },
    ],
    sponsor_required: true,
    scope_delegation: {
      enabled: true,
      mode: "intersection",
      escalation_policy: "hard_error",
    },
    budgets: {
      enabled: true,
      supported_limits: ["maxActionsPerHour"],
      alert_webhook_supported: true,
      auto_suspend_supported: false,
    },
    token_lifetimes: {
      access_token_default: "PT1H",
      refresh_token_default: "PT24H",
      maximum: "P30D",
      permanent_tokens_allowed: false,
    },
    endpoints: {
      tokens: {
        url: "https://relayauth.example.com/v1/tokens",
        methods: ["POST"],
        auth: "private_key_jwt",
        description: "Issues tokens.",
      },
    },
    ...overrides,
  };
}

test("agentCardToConfiguration maps skills and auth metadata", () => {
  const card: A2aAgentCard = {
    name: "planner",
    url: "https://agent.example.com/rpc",
    version: "1.2.3",
    capabilities: {
      streaming: true,
      stateTransitionHistory: true,
    },
    skills: [
      {
        id: "task-planning",
        name: "Task Planning",
        description: "Plan multi-step work.",
        examples: ["plan a release"],
      },
    ],
    authentication: {
      schemes: ["bearer", "private_key_jwt"],
    },
    provider: {
      url: "https://agent.example.com/docs",
    },
  };

  const configuration = agentCardToConfiguration(card);

  assert.equal(configuration.service_name, "planner");
  assert.equal(configuration.issuer, "https://agent.example.com");
  assert.equal(configuration.token_endpoint, "https://agent.example.com/rpc");
  assert.equal(configuration.identity_endpoint, "https://agent.example.com/rpc");
  assert.deepEqual(configuration.token_endpoint_auth_methods_supported, [
    "bearer_token",
    "private_key_jwt",
  ]);
  assert.deepEqual(configuration.capabilities, ["streaming", "state-transition-history"]);
  assert.equal(configuration.scope_definitions.length, 1);
  assert.equal(configuration.scope_definitions[0]?.pattern, "a2a:task-planning:invoke:*");
});

test("configurationToAgentCard maps scopes into A2A skills", () => {
  const card = configurationToAgentCard(buildConfiguration());

  assert.equal(card.name, "relayauth");
  assert.equal(card.url, "https://relayauth.example.com/v1/tokens");
  assert.deepEqual(card.authentication?.schemes, ["private_key_jwt", "client_secret_post"]);
  assert.equal(card.provider?.url, "https://docs.relayauth.example.com");
  assert.equal(card.skills?.length, 1);
  assert.equal(card.skills?.[0]?.id, "relayauth-identity");
  assert.deepEqual(card.skills?.[0]?.tags, ["read", "manage"]);
});

test("round-trip preserves essential identity and endpoint metadata", () => {
  const originalCard: A2aAgentCard = {
    name: "catalog",
    url: "https://catalog.example.com/a2a",
    skills: [{ id: "search", name: "Search" }],
    authentication: { schemes: ["client_secret_post"] },
  };

  const configuration = agentCardToConfiguration(originalCard);
  const roundTrippedCard = configurationToAgentCard(configuration);

  assert.equal(roundTrippedCard.name, "catalog");
  assert.equal(roundTrippedCard.url, "https://catalog.example.com/a2a");
  assert.deepEqual(roundTrippedCard.authentication?.schemes, ["client_secret_post"]);
  assert.equal(roundTrippedCard.skills?.[0]?.name, "Search");
});

test("agentCardToConfiguration handles missing optional fields", () => {
  const configuration = agentCardToConfiguration({
    name: "minimal",
    url: "https://minimal.example.com/rpc",
  });

  assert.equal(configuration.service_name, "minimal");
  assert.deepEqual(configuration.scope_definitions, []);
  assert.deepEqual(configuration.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(configuration.capabilities, []);
});

test("assertValidA2aAgentCard rejects cards without required fields", () => {
  assert.throws(
    () => assertValidA2aAgentCard({ url: "https://agent.example.com/rpc" }),
    /name/i,
  );

  assert.throws(
    () => assertValidA2aAgentCard({ name: "broken" }),
    /url/i,
  );
});
