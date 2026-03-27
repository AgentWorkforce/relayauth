import type { CloudflareStorageBindings } from "../storage/cloudflare.js";
import { createCloudflareStorage } from "../storage/cloudflare.js";
import { createApp } from "../worker.js";

export { IdentityDO } from "../durable-objects/index.js";

export default {
  async fetch(request: Request, env: CloudflareStorageBindings, ctx: ExecutionContext) {
    const storage = createCloudflareStorage(env);
    const app = createApp({
      defaultBindings: env,
      storage,
    });

    return app.fetch(request, env, ctx);
  },
};
