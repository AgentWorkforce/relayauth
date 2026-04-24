import process from "node:process";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AppConfig, AppEnv } from "./env.js";
import { apiKeyAuth } from "./middleware/api-key-auth.js";
import auditExport from "./routes/audit-export.js";
import auditQuery from "./routes/audit-query.js";
import auditWebhooks from "./routes/audit-webhooks.js";
import apiKeys from "./routes/api-keys.js";
import dashboardStats from "./routes/dashboard-stats.js";
import discovery, { apiDiscovery } from "./routes/discovery.js";
import jwks from "./routes/jwks.js";
import identityActivity from "./routes/identity-activity.js";
import identities from "./routes/identities.js";
import observerApp from "./routes/observer.js";
import policies from "./routes/policies.js";
import roleAssignments from "./routes/role-assignments.js";
import roles from "./routes/roles.js";
import tokens from "./routes/tokens.js";
import type { AuthStorage } from "./storage/index.js";

const PUBLIC_PATHS = new Set([
  "/health",
  "/.well-known/agent-configuration",
  "/v1/discovery/agent-card",
  "/v1/tokens/refresh",
]);
const BRIDGE_RATE_LIMIT = 30;
const BRIDGE_RATE_WINDOW_MS = 60_000;

export type CreateAppOptions = {
  storage?: AuthStorage;
  config?: Partial<AppConfig>;
  defaultBindings?: Partial<AppConfig>;
  internalSecret?: string;
  baseUrl?: string;
  allowedOrigins?: string;
};

export type StartServerOptions = {
  port?: number;
  dbPath?: string;
  storage?: AuthStorage;
  config?: Partial<AppConfig>;
};

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/.well-known/") || path.startsWith("/v1/observer/");
}

function normalizeConfig(options: CreateAppOptions): Partial<AppConfig> {
  return {
    ...(options.defaultBindings ?? {}),
    ...(options.config ?? {}),
    ...(options.internalSecret !== undefined ? { INTERNAL_SECRET: options.internalSecret } : {}),
    ...(options.baseUrl !== undefined ? { BASE_URL: options.baseUrl } : {}),
    ...(options.allowedOrigins !== undefined ? { ALLOWED_ORIGINS: options.allowedOrigins } : {}),
  };
}

function getClientIp(forwardedFor: string | undefined, realIp: string | undefined): string {
  const firstForwarded = forwardedFor?.split(",")[0]?.trim();
  return firstForwarded || realIp?.trim() || "unknown";
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const bridgeRateMap = new Map<string, { count: number; resetAt: number }>();
  const config = normalizeConfig(options);

  if (Object.keys(config).length > 0) {
    app.use("*", async (c, next) => {
      c.env = {
        ...(c.env ?? {}),
        ...config,
      } as AppEnv["Bindings"];
      await next();
    });
  }

  app.use("*", async (c, next) => {
    if (!options.storage) {
      throw new Error("storage is required — use createSqliteStorage (local) or provide a storage adapter");
    }

    c.set("storage", options.storage);
    await next();
  });

  app.use("*", async (c, next) => {
    const allowedRaw = c.env.ALLOWED_ORIGINS;
    const origin = c.req.header("Origin") ?? "";

    if (allowedRaw) {
      const allowed = allowedRaw.split(",").map((value) => value.trim()).filter(Boolean);
      return cors({ origin: allowed })(c, next);
    }

    return cors({ origin: () => (origin === "" ? "*" : "") })(c, next);
  });

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);
    c.set("requestId", requestId);
    await next();
  });

  // Mount apiKeyAuth() on every path that accepts x-api-key. It must run BEFORE the
  // global gate below so that, when an x-api-key is present, the middleware can
  // authenticate it and stash the resulting claims on Hono's context
  // (`c.set("apiKeyClaims", ...)` / `c.set("apiKeyVia", "api_key")`). The gate
  // below consults that context when deciding whether to admit the request.
  //
  // The old implementation rewrote `c.req.raw.headers.set("authorization", ...)`
  // to synthesize a Bearer for the gate to see, but Cloudflare Workers'
  // Request.headers is immutable — that mutation threw
  // `TypeError: Can't modify immutable headers` and 500'd every x-api-key
  // request in production. Context-based signaling avoids that.
  //
  // Wildcard mounts are required so sub-paths (e.g. /v1/identities/:id) also run
  // through the middleware — see P0-1 in PR #20.
  app.use("/v1/identities", apiKeyAuth());
  app.use("/v1/identities/*", apiKeyAuth());
  app.use("/v1/tokens", apiKeyAuth());
  app.use("/v1/tokens/*", apiKeyAuth());

  app.use("*", async (c, next) => {
    if (isPublicPath(c.req.path)) {
      return next();
    }

    // If apiKeyAuth() upstream authenticated an x-api-key, let the request
    // through — the downstream route handler will read the claims via
    // `c.get("apiKeyClaims")`. DO NOT fall back to raw `c.req.header("x-api-key")`
    // here: a new route added without mounting apiKeyAuth() would silently
    // accept unvalidated keys.
    if (c.get("apiKeyVia") === "api_key") {
      return next();
    }

    const authorization = c.req.header("Authorization");
    if (!authorization) {
      return c.json({ error: "Missing Authorization header", code: "missing_authorization" }, 401);
    }

    const [scheme, token] = authorization.split(/\s+/, 2);
    if (scheme !== "Bearer" || !token) {
      return c.json({ error: "Invalid Authorization header", code: "invalid_authorization" }, 401);
    }

    await next();
  });

  app.use("/v1/discovery/bridge", async (c, next) => {
    const ip = getClientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"));
    const now = Date.now();

    let entry = bridgeRateMap.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + BRIDGE_RATE_WINDOW_MS };
      bridgeRateMap.set(ip, entry);
    }

    entry.count++;
    if (entry.count > BRIDGE_RATE_LIMIT) {
      return c.json({ error: "Rate limit exceeded", code: "rate_limited" }, 429);
    }

    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/.well-known", discovery);
  app.route("/.well-known", jwks);
  app.route("/v1/discovery", apiDiscovery);
  app.route("/v1/api-keys", apiKeys);
  app.route("/v1/audit", auditWebhooks);
  app.route("/v1/audit", auditExport);
  app.route("/v1/audit", auditQuery);
  app.route("/v1/identities", identityActivity);
  app.route("/v1/identities", identities);
  app.route("/v1/identities", roleAssignments);
  app.route("/v1/observer", observerApp);
  app.route("/v1/policies", policies);
  app.route("/v1/roles", roles);
  app.route("/v1/stats", dashboardStats);
  app.route("/v1/tokens", tokens);

  return app;
}

export async function startServer(options: StartServerOptions = {}) {
  const port = Number.isFinite(options.port) ? (options.port as number) : 8787;
  let storage: AuthStorage;
  if (options.storage) {
    storage = options.storage;
  } else {
    // Dynamic import to avoid bundling sqlite (uses Function()) in Workers
    const { createSqliteStorage } = await import("./storage/sqlite.js");
    storage = createSqliteStorage(options.dbPath);
  }
  const internalSecret =
    options.config?.INTERNAL_SECRET
    ?? process.env.INTERNAL_SECRET
    ?? ("INTERNAL_SECRET" in storage && typeof storage.INTERNAL_SECRET === "string"
      ? storage.INTERNAL_SECRET
      : "internal-test-secret");
  const config: AppConfig = {
    INTERNAL_SECRET: internalSecret,
    BASE_URL: options.config?.BASE_URL ?? process.env.BASE_URL ?? `http://127.0.0.1:${port}`,
    ALLOWED_ORIGINS: options.config?.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS,
    RELAYAUTH_SIGNING_KEY_PEM:
      options.config?.RELAYAUTH_SIGNING_KEY_PEM ?? process.env.RELAYAUTH_SIGNING_KEY_PEM,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC:
      options.config?.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC ?? process.env.RELAYAUTH_SIGNING_KEY_PEM_PUBLIC,
    RELAYAUTH_ENV_STAGE: options.config?.RELAYAUTH_ENV_STAGE ?? process.env.RELAYAUTH_ENV_STAGE,
  };

  const app = createApp({
    storage,
    config,
  });

  console.log(`relayauth listening on :${port}`);

  return serve({
    port,
    fetch: (request) => app.fetch(request, config),
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  startServer({
    port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined,
    dbPath: process.env.RELAYAUTH_DB_PATH ?? process.env.DB_PATH,
  });
}
