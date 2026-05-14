export const RELAY_AGENT_TOKEN_PREFIX = "relay_ag_";
export const RELAY_PATH_TOKEN_PREFIX = "relay_pa_";
const RELAY_TOKEN_PREFIXES = [RELAY_AGENT_TOKEN_PREFIX, RELAY_PATH_TOKEN_PREFIX] as const;
export type RelayTokenPrefix = typeof RELAY_TOKEN_PREFIXES[number];

export function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

export function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    return JSON.parse(decodeBase64Url(value)) as T;
  } catch {
    return null;
  }
}

export function decodeBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

export function wrapAgentToken(token: string): string {
  return `${RELAY_AGENT_TOKEN_PREFIX}${token}`;
}

export function wrapRelayToken(token: string, prefix: RelayTokenPrefix): string {
  return `${prefix}${token}`;
}

export function unwrapRelayToken(token: string): string {
  for (const prefix of RELAY_TOKEN_PREFIXES) {
    if (token.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }

  return token;
}

export function splitJwtSegments(token: string): [string, string, string] | null {
  const normalized = unwrapRelayToken(token);
  const parts = normalized.split(".");
  if (parts.length !== 3) {
    return null;
  }

  return [parts[0], parts[1], parts[2]];
}
