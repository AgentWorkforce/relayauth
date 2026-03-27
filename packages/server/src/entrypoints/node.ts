import process from "node:process";

import { serve } from "@hono/node-server";

import type { AppEnv } from "../env.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import { createApp } from "../worker.js";

export function startLocalServer(opts: {
  port?: number;
  signingKey?: string;
  dbPath?: string;
}) {
  const port = Number.isFinite(opts.port) ? (opts.port as number) : 8787;
  const storage = createSqliteStorage(opts.dbPath);
  const bindings: AppEnv["Bindings"] = {
    SIGNING_KEY: opts.signingKey ?? "dev-secret",
    SIGNING_KEY_ID: "dev-key",
    INTERNAL_SECRET: storage.INTERNAL_SECRET,
    BASE_URL: `http://127.0.0.1:${port}`,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  };

  const app = createApp({
    defaultBindings: bindings,
    storage,
  });

  console.log(`relayauth listening on :${port}`);

  return serve({
    port,
    fetch: (request) => app.fetch(request, bindings),
  });
}
