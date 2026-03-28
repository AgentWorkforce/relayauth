import type { StartServerOptions } from "../server.js";
import { startServer } from "../server.js";

export type StartLocalServerOptions = StartServerOptions & {
  signingKey?: string;
};

/**
 * Backwards-compatible entry point. Accepts the old `signingKey` option
 * and maps it to the new config-based API.
 */
export function startLocalServer(opts: StartLocalServerOptions = {}) {
  const { signingKey, ...rest } = opts;
  return startServer({
    ...rest,
    config: {
      ...rest.config,
      ...(signingKey !== undefined ? { SIGNING_KEY: signingKey } : {}),
    },
  });
}
