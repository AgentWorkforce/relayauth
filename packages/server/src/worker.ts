import { Hono } from "hono";
import type { AppEnv } from "./env.js";

// Placeholder; routes are added by later workflows.
const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;

// Durable Object exports are added by later workflows.
