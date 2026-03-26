import type {
  AgentConfiguration,
  AgentIdentity,
  RelayAuthTokenClaims,
  TokenPair,
} from "@relayauth/types";
import {
  RelayAuthClient,
  RelayAuthError,
  ScopeChecker,
  TokenVerifier,
  type VerifyOptions,
} from "@relayauth/sdk";

import { RELAYAUTH_TOOLS } from "./tools.js";
import type { AdapterConfig, AdapterOptions, AdapterTool, ToolResult } from "./types.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1_048_576; // 1 MB

/** Check whether an IPv4 first two octets fall in private/reserved ranges. */
function isPrivateIPv4(a: number, b: number): boolean {
  return a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127); // CGNAT (RFC 6598)
}

/**
 * Comprehensive private/reserved host check to mitigate SSRF.
 * Handles decimal IPs, octal/hex octets, IPv6, DNS rebinding services,
 * and .localhost subdomains (RFC 6761).
 */
function isPrivateUrl(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  const h = url.hostname.trim().toLowerCase();

  // Block localhost and .localhost subdomains (RFC 6761)
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "[::1]"
  ) {
    return true;
  }

  // Block known DNS-rebinding services
  if (
    h.endsWith(".nip.io") ||
    h.endsWith(".sslip.io") ||
    h.endsWith(".xip.io")
  ) {
    return true;
  }

  // IPv6 addresses (may be bracketed)
  if (h.includes(":")) {
    const compact = h.replace(/^\[|\]$/g, "");

    // Unspecified (::), loopback (::1), ULA (fc00::/7), link-local (fe80::/10)
    if (
      compact === "::" ||
      compact === "::1" ||
      compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      compact.startsWith("fe80:")
    ) {
      return true;
    }

    // IPv4-mapped (::ffff:x.x.x.x) and IPv4-compatible (::x.x.x.x) IPv6
    const v4Mapped = compact.match(
      /^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/,
    );
    if (v4Mapped) {
      return isPrivateIPv4(Number(v4Mapped[1]), Number(v4Mapped[2]));
    }

    return false;
  }

  // Decimal IP (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(h)) {
    const decimal = Number(h);
    if (decimal >= 0 && decimal <= 0xFFFFFFFF) {
      const a = (decimal >>> 24) & 0xFF;
      const b = (decimal >>> 16) & 0xFF;
      return isPrivateIPv4(a, b);
    }
  }

  // Dotted notation — handle octal (0177) and hex (0x7f) segments
  const segments = h.split(".");
  if (segments.length === 4) {
    const octets = segments.map((s) => {
      if (s.startsWith("0x") || s.startsWith("0X")) return parseInt(s, 16);
      if (s.startsWith("0") && s.length > 1) return parseInt(s, 8);
      return Number(s);
    });
    if (octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
      return isPrivateIPv4(octets[0], octets[1]);
    }
  }

  return false;
}

type ExecuteWithAuthResult = {
  status: number;
  headers: Record<string, string>;
  data: unknown;
};

type ScopeCheckResult = {
  granted: boolean;
  scope: string;
  claims: RelayAuthTokenClaims;
};

type RegisterAgentResult = {
  identity: AgentIdentity;
  token?: TokenPair;
};

type RequestScopeResult = {
  identityId: string;
  scopes: string[];
  token: TokenPair;
};

type ResolvedAdapterConfig = Omit<AdapterConfig, "options"> & AdapterOptions;

export class RelayAuthAdapter {
  readonly config: AdapterConfig;

  #resolvedConfig: ResolvedAdapterConfig;
  #client?: RelayAuthClient;
  #verifier?: TokenVerifier;
  #discoveryPromise?: Promise<AgentConfiguration>;
  #issuedToken?: TokenPair;
  #identity?: AgentIdentity;

  constructor(config: AdapterConfig) {
    this.config = config;
    this.#resolvedConfig = resolveConfig(config);
  }

  getTools(): AdapterTool[] {
    return RELAYAUTH_TOOLS.map((tool) => ({
      ...tool,
      parameters: cloneSchema(tool.parameters),
    }));
  }

  async executeTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (name) {
      case "discover_service":
        if (params.url !== undefined && typeof params.url !== "string") {
          return { success: false, error: "url must be a string" };
        }
        return this.discover(params.url as string | undefined);
      case "register_agent":
        if (typeof params.name !== "string") {
          return { success: false, error: "name must be a string" };
        }
        if (params.scopes !== undefined && !Array.isArray(params.scopes)) {
          return { success: false, error: "scopes must be an array" };
        }
        if (params.sponsor !== undefined && typeof params.sponsor !== "string") {
          return { success: false, error: "sponsor must be a string" };
        }
        return this.registerAgent(
          params.name,
          params.scopes as string[] | undefined,
          params.sponsor as string | undefined,
        );
      case "request_scope":
        if (!Array.isArray(params.scopes)) {
          return { success: false, error: "scopes must be an array" };
        }
        if (params.identityId !== undefined && typeof params.identityId !== "string") {
          return { success: false, error: "identityId must be a string" };
        }
        return this.requestScope(
          params.scopes as string[],
          params.identityId as string | undefined,
        );
      case "execute_with_auth":
        if (typeof params.url !== "string") {
          return { success: false, error: "url must be a string" };
        }
        if (params.method !== undefined && typeof params.method !== "string") {
          return { success: false, error: "method must be a string" };
        }
        return this.executeWithAuth(
          params.url,
          (params.method as HttpMethod) ?? "GET",
          params.body,
          params.headers as Record<string, string> | undefined,
        );
      case "check_scope":
        if (typeof params.scope !== "string") {
          return { success: false, error: "scope must be a string" };
        }
        return this.checkScope(params.scope);
      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  async discover(url = this.#resolvedConfig.serverUrl): Promise<ToolResult<AgentConfiguration>> {
    try {
      const configuration = await this.#discoverConfiguration(url);
      return {
        success: true,
        data: configuration,
      };
    } catch (error) {
      return this.#failure(error);
    }
  }

  async registerAgent(
    name: string,
    scopes: string[] = this.#resolvedConfig.defaultScopes ?? [],
    sponsor?: string,
  ): Promise<ToolResult<RegisterAgentResult>> {
    try {
      if (this.#resolvedConfig.autoDiscover !== false) {
        await this.#ensureDiscovered();
      }

      const claims = await this.#resolveClaimsOrNull();
      const orgId = this.#resolvedConfig.orgId ?? claims?.org ?? "default";
      const workspaceId = this.#resolvedConfig.workspaceId ?? claims?.wks;
      const identity = await this.client.createIdentity(orgId, {
        name,
        type: "agent",
        scopes,
        metadata: sponsor ? { sponsor } : undefined,
        workspaceId,
      });

      this.#identity = identity;

      let token: TokenPair | undefined;
      if (this.#resolvedConfig.autoIssueToken) {
        token = await this.client.issueToken(identity.id, {
          scopes: scopes.length > 0 ? scopes : undefined,
          audience: this.#resolvedConfig.audience,
          expiresIn: this.#resolvedConfig.tokenExpiresIn,
        });
        this.#issuedToken = token;
        this.#client = undefined;
      }

      return {
        success: true,
        data: {
          identity,
          token,
        },
      };
    } catch (error) {
      return this.#failure(error);
    }
  }

  async requestScope(
    scopes: string[],
    identityId?: string,
  ): Promise<ToolResult<RequestScopeResult>> {
    try {
      if (this.#resolvedConfig.autoDiscover !== false) {
        await this.#ensureDiscovered();
      }

      const targetIdentityId = identityId
        ?? this.#identity?.id
        ?? (await this.#resolveClaimsOrNull())?.sub;

      if (!targetIdentityId) {
        return {
          success: false,
          error: "No identity is available for token issuance.",
        };
      }

      const token = await this.client.issueToken(targetIdentityId, {
        scopes,
        audience: this.#resolvedConfig.audience,
        expiresIn: this.#resolvedConfig.tokenExpiresIn,
      });

      this.#issuedToken = token;
      this.#client = undefined;

      return {
        success: true,
        data: {
          identityId: targetIdentityId,
          scopes,
          token,
        },
      };
    } catch (error) {
      return this.#failure(error);
    }
  }

  async executeWithAuth(
    url: string,
    method: HttpMethod = "GET",
    body?: unknown,
    headers?: HeadersInit,
  ): Promise<ToolResult<ExecuteWithAuthResult>> {
    try {
      let targetUrl: URL;
      try {
        targetUrl = new URL(url);
      } catch {
        return { success: false, error: "Invalid URL" };
      }

      if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
        return { success: false, error: "Only http and https URLs are allowed" };
      }

      if (isPrivateUrl(targetUrl)) {
        return { success: false, error: "Requests to private/internal addresses are not allowed" };
      }

      const token = this.#getAccessToken();
      if (!token) {
        return {
          success: false,
          error: "No RelayAuth access token is configured.",
        };
      }

      const requestHeaders = new Headers(headers);
      requestHeaders.set("authorization", `Bearer ${token}`);

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);

      const init: RequestInit = {
        method,
        headers: requestHeaders,
        redirect: "manual" as RequestRedirect,
        signal: abort.signal,
      };

      if (body !== undefined && method !== "GET") {
        const serialized = serializeRequestBody(body, requestHeaders);
        init.body = serialized;
      }

      const response = await fetch(url, init);
      clearTimeout(timer);

      // Block redirects to private addresses
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          try {
            const redirectUrl = new URL(location, url);
            if (isPrivateUrl(redirectUrl)) {
              return { success: false, error: "Redirect to private/internal address blocked" };
            }
          } catch {
            // invalid redirect URL — block it
            return { success: false, error: "Invalid redirect location" };
          }
        }
        return { success: false, error: `Redirect not followed (status ${response.status})` };
      }

      const text = await response.text();
      const parsed = parseResponseBody(text);

      if (!response.ok) {
        return {
          success: false,
          error: typeof parsed === "string" ? parsed : `Request failed with status ${response.status}`,
        };
      }

      return {
        success: true,
        data: {
          status: response.status,
          headers: headersToObject(response.headers),
          data: parsed,
        },
      };
    } catch (error) {
      return this.#failure(error);
    }
  }

  async checkScope(scope: string): Promise<ToolResult<ScopeCheckResult>> {
    try {
      const token = this.#getAccessToken();
      if (!token) {
        return {
          success: false,
          error: "No RelayAuth access token is configured.",
        };
      }

      const verifier = await this.#getVerifier();
      const claims = await verifier.verify(token);
      const granted = ScopeChecker.fromToken(claims).check(scope);

      return {
        success: true,
        data: {
          granted,
          scope,
          claims,
        },
      };
    } catch (error) {
      return this.#failure(error);
    }
  }

  #clientToken?: string;

  protected get client(): RelayAuthClient {
    const currentToken = this.#issuedToken?.accessToken ?? this.#resolvedConfig.token;
    if (this.#client && this.#clientToken !== currentToken) {
      this.#client = undefined;
    }
    this.#client ??= new RelayAuthClient({
      baseUrl: this.#resolvedConfig.serverUrl,
      apiKey: this.#resolvedConfig.apiKey,
      token: currentToken,
    });
    this.#clientToken = currentToken;
    return this.#client;
  }

  protected async getVerifiedClaims(): Promise<RelayAuthTokenClaims> {
    const token = this.#getAccessToken();
    if (!token) {
      throw new RelayAuthError("No RelayAuth access token is configured.", "missing_token", 401);
    }

    const verifier = await this.#getVerifier();
    return verifier.verify(token);
  }

  async #discoverConfiguration(url: string): Promise<AgentConfiguration> {
    const normalizedUrl = normalizeBaseUrl(url);
    const isDefaultUrl = normalizedUrl === normalizeBaseUrl(this.#resolvedConfig.serverUrl);

    if (isDefaultUrl) {
      this.#discoveryPromise ??= fetchConfiguration(normalizedUrl).catch((error) => {
        this.#discoveryPromise = undefined;
        throw error;
      });
      return this.#discoveryPromise;
    }

    return fetchConfiguration(normalizedUrl);
  }

  async #ensureDiscovered(): Promise<AgentConfiguration> {
    const discovery = await this.#discoverConfiguration(this.#resolvedConfig.serverUrl);

    const nextConfig: ResolvedAdapterConfig = {
      ...this.#resolvedConfig,
      issuer: this.#resolvedConfig.issuer ?? discovery.issuer,
      jwksUrl: this.#resolvedConfig.jwksUrl ?? discovery.jwks_uri,
      revocationUrl: this.#resolvedConfig.revocationUrl ?? discovery.revocation_endpoint,
    };

    if (!areVerifyOptionsEqual(this.#resolvedConfig, nextConfig)) {
      this.#resolvedConfig = nextConfig;
      this.#verifier = undefined;
    }

    return discovery;
  }

  async #getVerifier(): Promise<TokenVerifier> {
    if (!this.#resolvedConfig.jwksUrl && this.#resolvedConfig.autoDiscover !== false) {
      await this.#ensureDiscovered();
    }

    this.#verifier ??= new TokenVerifier(this.#buildVerifyOptions());
    return this.#verifier;
  }

  #buildVerifyOptions(): VerifyOptions {
    const {
      audience,
      cacheTtlMs,
      checkRevocation,
      issuer,
      jwksUrl,
      maxAge,
      revocationUrl,
    } = this.#resolvedConfig;

    return {
      audience,
      cacheTtlMs,
      checkRevocation,
      issuer,
      jwksUrl,
      maxAge,
      revocationUrl,
    };
  }

  #getAccessToken(): string | undefined {
    return this.#issuedToken?.accessToken ?? this.#resolvedConfig.token;
  }

  async #resolveClaimsOrNull(): Promise<RelayAuthTokenClaims | null> {
    const token = this.#getAccessToken();
    if (!token) {
      return null;
    }

    try {
      const verifier = await this.#getVerifier();
      return await verifier.verify(token);
    } catch {
      return null;
    }
  }

  #failure<TData = never>(error: unknown): ToolResult<TData> {
    return {
      success: false,
      error: formatError(error),
    };
  }
}

function resolveConfig(config: AdapterConfig): ResolvedAdapterConfig {
  return {
    ...config,
    ...(config.options ?? {}),
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    autoDiscover: config.autoDiscover ?? true,
  };
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchConfiguration(baseUrl: string): Promise<AgentConfiguration> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(new URL(".well-known/agent-configuration", baseUrl), {
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new RelayAuthError(
      "Failed to discover RelayAuth service",
      "discovery_failed",
      response.status,
    );
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new RelayAuthError(
      "Discovery response exceeds size limit",
      "discovery_failed",
      413,
    );
  }

  return JSON.parse(text) as AgentConfiguration;
}

function cloneSchema<T>(value: T): T {
  return structuredClone(value);
}

function serializeRequestBody(body: unknown, headers: Headers): BodyInit {
  if (
    typeof body === "string"
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof URLSearchParams
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
  ) {
    return body as BodyInit;
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return JSON.stringify(body);
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function formatError(error: unknown): string {
  if (error instanceof RelayAuthError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function arraysEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true;
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((v, i) => v === right[i]);
}

function areVerifyOptionsEqual(
  previous: ResolvedAdapterConfig,
  next: ResolvedAdapterConfig,
): boolean {
  return (
    previous.jwksUrl === next.jwksUrl
    && previous.issuer === next.issuer
    && previous.revocationUrl === next.revocationUrl
    && previous.cacheTtlMs === next.cacheTtlMs
    && previous.checkRevocation === next.checkRevocation
    && previous.maxAge === next.maxAge
    && arraysEqual(previous.audience, next.audience)
  );
}
