import type { CloudflareStorageBindings } from "../storage/cloudflare.js";
import { createCloudflareStorage } from "../storage/cloudflare.js";
import { createApp } from "../worker.js";

export { IdentityDO } from "../durable-objects/index.js";

let _app: ReturnType<typeof createApp> | null = null;

export default {
  fetch(request: Request, env: CloudflareStorageBindings, ctx: ExecutionContext) {
    if (!_app) {
      const storage = createCloudflareStorage(env);
      _app = createApp({
        defaultBindings: env,
        storage,
      });
    }

    return _app.fetch(request, env, ctx);
  },
};
