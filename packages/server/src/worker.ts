import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env.js";
export { IdentityDO } from "./durable-objects/index.js";
import auditExport from "./routes/audit-export.js";
import auditQuery from "./routes/audit-query.js";
import auditWebhooks from "./routes/audit-webhooks.js";
import dashboardStats from "./routes/dashboard-stats.js";
import identityActivity from "./routes/identity-activity.js";
import identities from "./routes/identities.js";
import policies from "./routes/policies.js";
import roleAssignments from "./routes/role-assignments.js";
import roles from "./routes/roles.js";

const app = new Hono<AppEnv>();

// Global middleware: CORS, request ID
app.use("*", cors());
app.use("*", async (c, next) => {
  const requestId =
    c.req.header("x-request-id") ?? crypto.randomUUID();
  c.header("x-request-id", requestId);
  c.set("requestId", requestId);
  await next();
});

// NOTE: Add global auth middleware here when route modules are mounted.
// Auth-at-route-level is error-prone — new routes risk bypassing auth.

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/v1/audit", auditWebhooks);
app.route("/v1/audit", auditExport);
app.route("/v1/audit", auditQuery);
app.route("/v1/identities", identityActivity);
app.route("/v1/identities", identities);
app.route("/v1/identities", roleAssignments);
app.route("/v1/policies", policies);
app.route("/v1/roles", roles);
app.route("/v1/stats", dashboardStats);

export default app;
