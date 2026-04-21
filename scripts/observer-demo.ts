#!/usr/bin/env -S tsx
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
type ScenarioId = "1" | "2" | "3" | "4";
type Attempt = {
  label: string;
  method: string;
  path: string;
  status?: number;
  bodyText?: string;
  bodySnippet?: string;
  networkError?: string;
};
type ScenarioResult = {
  id: ScenarioId;
  name: string;
  expectedEvent: string;
  attempts: Attempt[];
};
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokenScript = join(repoRoot, "scripts", "generate-dev-token.sh");
const baseUrl = (process.env.RELAYAUTH_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const runId = `${Date.now().toString(36)}-${process.pid}`;
const org = process.env.RELAYAUTH_ORG ?? "org_observer_demo";
const workspace = process.env.RELAYAUTH_WORKSPACE ?? "ws_observer_demo";
const sponsor = process.env.RELAYAUTH_SPONSOR ?? "user_observer_demo";

const meta: Record<ScenarioId, { name: string; expectedEvent: string }> = {
  "1": {
    name: "Scope-denied: read-only token tries POST /v1/identities",
    expectedEvent: "scope.denied",
  },
  "2": {
    name: "Scope-allowed: admin token reads identities",
    expectedEvent: "token.verified + scope.check allowed",
  },
  "3": {
    name: "Token invalid: expired token reads roles",
    expectedEvent: "token.invalid",
  },
  "4": {
    name: "Budget alert: force identity usage over budget",
    expectedEvent: "budget.alert",
  },
};

const runners: Record<ScenarioId, () => Promise<ScenarioResult>> = {
  "1": runScopeDenied,
  "2": runScopeAllowed,
  "3": runTokenInvalid,
  "4": runBudgetAlert,
};

async function main(): Promise<void> {
  const selected = parseScenarioArg(process.argv.slice(2));
  const ids = selected ? [selected] : (["1", "2", "3", "4"] as ScenarioId[]);
  const results: ScenarioResult[] = [];

  console.log("RelayAuth Observer Demo");
  console.log(`Server: ${baseUrl}`);
  console.log(`Org: ${org}`);
  console.log("");

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    console.log(`Scenario ${id}: ${meta[id].name}`);
    console.log(`Expected event: ${meta[id].expectedEvent}`);
    const result = await runners[id]();
    results.push(result);
    result.attempts.forEach(printAttempt);
    console.log("");
    if (index < ids.length - 1) {
      await sleep(1_500);
    }
  }

  printSummary(results);
  if (results.some((result) => result.attempts.some((attempt) => attempt.networkError))) {
    process.exitCode = 1;
  }
}

async function runScopeDenied(): Promise<ScenarioResult> {
  const token = generateDevToken({
    sub: `observer-denied-${runId}`,
    scopes: ["relayauth:identity:read:*"],
  });
  const attempt = await requestJson("POST /v1/identities", {
    method: "POST",
    path: "/v1/identities",
    token,
    body: {
      name: `observer-denied-${runId}`,
      type: "agent",
      sponsorId: sponsor,
      scopes: ["relayfile:fs:read:/github/*"],
      metadata: { scenario: "observer-demo-1" },
    },
  });
  return result("1", [attempt]);
}

async function runScopeAllowed(): Promise<ScenarioResult> {
  const token = generateDevToken({
    sub: `observer-admin-read-${runId}`,
    scopes: [
      "relayauth:identity:read:*",
      "relayauth:identity:manage:*",
      "relayauth:role:read:*",
      "relayauth:policy:manage:*",
    ],
  });
  const attempt = await requestJson("GET /v1/identities", {
    method: "GET",
    path: "/v1/identities?limit=5",
    token,
  });
  return result("2", [attempt]);
}

async function runTokenInvalid(): Promise<ScenarioResult> {
  const expiredToken = generateDevToken({
    sub: `observer-expired-${runId}`,
    scopes: ["relayauth:role:read:*"],
    ttlSeconds: -60,
  });
  const attempt = await requestJson("GET /v1/roles with expired token", {
    method: "GET",
    path: "/v1/roles",
    token: expiredToken,
  });
  return result("3", [attempt]);
}

async function runBudgetAlert(): Promise<ScenarioResult> {
  const token = generateDevToken({
    sub: `observer-budget-admin-${runId}`,
    scopes: ["relayauth:identity:manage:*", "relayauth:identity:read:*"],
  });
  const budget = {
    maxActionsPerHour: 1,
    maxCostPerDay: 100,
    alertThreshold: 0.5,
    autoSuspend: true,
  };
  const createAttempt = await requestJson("POST /v1/identities budgeted agent", {
    method: "POST",
    path: "/v1/identities",
    token,
    body: {
      name: `observer-budget-${runId}`,
      type: "agent",
      sponsorId: sponsor,
      scopes: ["relayfile:fs:read:/github/*"],
      metadata: { scenario: "observer-demo-4" },
      budget,
    },
  });
  const attempts = [createAttempt];
  const createdId = readJsonString(createAttempt.bodyText, "id");
  if (!createdId) {
    attempts.push({
      label: "PATCH /v1/identities/:id budgetUsage",
      method: "PATCH",
      path: "/v1/identities/:id",
      bodySnippet: "Skipped because the create response did not include an identity id.",
    });
    return result("4", attempts);
  }

  attempts.push(await requestJson("PATCH /v1/identities/:id budgetUsage", {
    method: "PATCH",
    path: `/v1/identities/${encodeURIComponent(createdId)}`,
    token,
    body: {
      budget,
      budgetUsage: {
        actionsThisHour: 2,
        costToday: 0,
        lastResetAt: new Date().toISOString(),
      },
    },
  }));
  return result("4", attempts);
}

function result(id: ScenarioId, attempts: Attempt[]): ScenarioResult {
  return { id, name: meta[id].name, expectedEvent: meta[id].expectedEvent, attempts };
}

function generateDevToken(options: {
  sub: string;
  scopes: string[];
  ttlSeconds?: number;
}): string {
  return execFileSync("bash", [tokenScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELAYAUTH_SUB: options.sub,
      RELAYAUTH_ORG: org,
      RELAYAUTH_WORKSPACE: workspace,
      RELAYAUTH_SPONSOR: sponsor,
      RELAYAUTH_SCOPES_JSON: JSON.stringify(options.scopes),
      LC_ALL: "C",
      ...(options.ttlSeconds === undefined
        ? {}
        : { RELAYAUTH_TTL_SECONDS: String(options.ttlSeconds) }),
    },
  }).trim();
}

async function requestJson(
  label: string,
  options: { method: string; path: string; token: string; body?: unknown },
): Promise<Attempt> {
  try {
    const response = await fetch(`${baseUrl}${options.path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return {
      label,
      method: options.method,
      path: options.path,
      status: response.status,
      bodyText: text,
      bodySnippet: snippet(text),
    };
  } catch (error) {
    return {
      label,
      method: options.method,
      path: options.path,
      networkError: error instanceof Error ? error.message : String(error),
    };
  }
}

function printAttempt(attempt: Attempt): void {
  console.log(`Attempt: ${attempt.label}`);
  console.log(`  Request: ${attempt.method} ${attempt.path}`);
  if (attempt.networkError) {
    console.log(`  Network error: ${attempt.networkError}`);
    return;
  }
  console.log(`  HTTP status: ${attempt.status ?? "n/a"}`);
  console.log(`  Response: ${attempt.bodySnippet || "(empty)"}`);
}

function printSummary(results: ScenarioResult[]): void {
  console.log("Summary");
  for (const result of results) {
    const statuses = result.attempts
      .map((attempt) => attempt.networkError ? "NETWORK_ERROR" : String(attempt.status ?? "n/a"))
      .join(" -> ");
    console.log(`  ${result.id}. ${result.name} | expected=${result.expectedEvent} | status=${statuses}`);
  }
}

function readJsonString(text: string | undefined, key: string): string | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function snippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

function parseScenarioArg(args: string[]): ScenarioId | undefined {
  const explicit = args.find((arg) => arg.startsWith("--scenario="));
  const value = explicit?.split("=", 2)[1] ?? (args[0] === "--scenario" ? args[1] : undefined);
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value === "2" || value === "3" || value === "4") {
    return value;
  }
  console.error("Usage: scripts/observer-demo.ts [--scenario=1|2|3|4]");
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
