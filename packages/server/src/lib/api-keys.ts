import crypto from "node:crypto";

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `rak_${Buffer.from(bytes).toString("base64url")}`;
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export function extractPrefix(apiKey: string): string {
  return apiKey.slice(0, 8);
}
