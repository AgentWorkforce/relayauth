import process from "node:process";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AppConfig, AppEnv } from "./env.js";
import auditExport from "./routes/audit-export.js";
import auditQuery from "./routes/audit-query.js";
import auditWebhooks from "./routes/audit-webhooks.js";
import dashboardStats from "./routes/dashboard-stats.js";
import discovery, { apiDiscovery } from "./routes/discovery.js";
import jwks from "./routes/jwks.js";
import identityActivity from "./routes/identity-activity.js";
import identities from "./routes/identities.js";
import policies from "./routes/policies.js";
import roleAssignments from "./routes/role-assignments.js";
import roles from "./routes/roles.js";
import type { AuthStorage } from "./storage/index.js";

const PUBLIC_PATHS = new Set([
  "/health",
  "/.well-known/agent-configuration",
  "/v1/discovery/agent-card",
]);
const BRIDGE_RATE_LIMIT = 30;
const BRIDGE_RATE_WINDOW_MS = 60_000;

export type CreateAppOptions = {
  storage?: AuthStorage;
  config?: Partial<AppConfig>;
  defaultBindings?: Partial<AppConfig>;
  signingKey?: string;
  signingKeyId?: string;
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
  return PUBLIC_PATHS.has(path) || path.startsWith("/.well-known/");
}

function normalizeConfig(options: CreateAppOptions): Partial<AppConfig> {
  return {
    ...(options.defaultBindings ?? {}),
    ...(options.config ?? {}),
    ...(options.signingKey !== undefined ? { SIGNING_KEY: options.signingKey } : {}),
    ...(options.signingKeyId !== undefined ? { SIGNING_KEY_ID: options.signingKeyId } : {}),
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
      Object.assign(c.env as Record<string, unknown>, config);
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

  app.use("*", async (c, next) => {
    if (isPublicPath(c.req.path)) {
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
  app.route("/v1/audit", auditWebhooks);
  app.route("/v1/audit", auditExport);
  app.route("/v1/audit", auditQuery);
  app.route("/v1/identities", identityActivity);
  app.route("/v1/identities", identities);
  app.route("/v1/identities", roleAssignments);
  app.route("/v1/policies", policies);
  app.route("/v1/roles", roles);
  app.route("/v1/stats", dashboardStats);

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
    SIGNING_KEY: options.config?.SIGNING_KEY ?? process.env.SIGNING_KEY ?? "dev-secret",
    SIGNING_KEY_ID: options.config?.SIGNING_KEY_ID ?? process.env.SIGNING_KEY_ID ?? "dev-key",
    INTERNAL_SECRET: internalSecret,
    BASE_URL: options.config?.BASE_URL ?? process.env.BASE_URL ?? `http://127.0.0.1:${port}`,
    ALLOWED_ORIGINS: options.config?.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS,
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
