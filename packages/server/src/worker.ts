import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env.js";
export { IdentityDO } from "./durable-objects/index.js";
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

// Routes that do not require authentication
const PUBLIC_PATHS = new Set([
  "/health",
  "/.well-known/agent-configuration",
  "/v1/discovery/agent-card",
]);

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/.well-known/");
}

// Per-IP rate limiting for the bridge endpoint (SSRF-sensitive)
const BRIDGE_RATE_LIMIT = 30; // requests per window
const BRIDGE_RATE_WINDOW_MS = 60_000; // 1 minute

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const bridgeRateMap = new Map<string, { count: number; resetAt: number }>();

  // Global middleware: CORS with origin restriction
  app.use("*", async (c, next) => {
    const allowedRaw = c.env.ALLOWED_ORIGINS;
    const origin = c.req.header("Origin") ?? "";

    if (allowedRaw) {
      const allowed = allowedRaw.split(",").map((o) => o.trim()).filter(Boolean);
      return cors({ origin: allowed })(c, next);
    }

    // No ALLOWED_ORIGINS configured: deny cross-origin requests by omitting
    // the Access-Control-Allow-Origin header (same-origin requests still work).
    return cors({ origin: () => (origin === "" ? "*" : "") })(c, next);
  });

  // Request ID middleware
  app.use("*", async (c, next) => {
    const requestId =
      c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);
    c.set("requestId", requestId);
    await next();
  });

  // Default-deny auth middleware: all non-public routes require a valid Bearer token.
  // Individual routes still enforce scope checks via requireScope().
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

    // Token is present and well-formed; per-route middleware handles full verification.
    await next();
  });

  app.use("/v1/discovery/bridge", async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
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

const app = createApp();
export default app;
