import { Hono } from "hono";
import type { AppEnv } from "./env.js";
export { IdentityDO } from "./durable-objects/index.js";
import identities from "./routes/identities.js";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/v1/identities", identities);

export default app;
