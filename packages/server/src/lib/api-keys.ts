import crypto from "node:crypto";

export const DEFAULT_API_KEY_PREFIX = "rak_";
export const WORKSPACE_TOKEN_PREFIX = "relay_ws_";

export function generateApiKey(prefix = DEFAULT_API_KEY_PREFIX): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${Buffer.from(bytes).toString("base64url")}`;
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export function extractPrefix(apiKey: string): string {
  return apiKey.slice(0, Math.min(apiKey.length, 16));
}
