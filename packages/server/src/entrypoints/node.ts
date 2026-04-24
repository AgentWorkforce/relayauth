import { startServer } from "../server.js";

export type { StartServerOptions as StartLocalServerOptions } from "../server.js";

export function startLocalServer(opts: import("../server.js").StartServerOptions = {}) {
  return startServer(opts);
}
