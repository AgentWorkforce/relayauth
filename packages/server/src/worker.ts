import { Hono } from "hono";
import type { AppEnv } from "./env.js";
export { IdentityDO } from "./durable-objects/index.js";

// Placeholder; routes are added by later workflows.
const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
