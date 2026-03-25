import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env.js";

// Placeholder; routes are added by later workflows.
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

export default app;

// Durable Object exports are added by later workflows.
