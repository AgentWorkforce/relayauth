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
        return this.discover(params.url as string | undefined);
      case "register_agent":
        return this.registerAgent(
          params.name as string,
          params.scopes as string[] | undefined,
          params.sponsor as string | undefined,
        );
      case "request_scope":
        return this.requestScope(
          params.scopes as string[],
          params.identityId as string | undefined,
        );
      case "execute_with_auth":
        return this.executeWithAuth(
          params.url as string,
          (params.method as HttpMethod) ?? "GET",
          params.body,
          params.headers as Record<string, string> | undefined,
        );
      case "check_scope":
        return this.checkScope(params.scope as string);
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
      const token = this.#getAccessToken();
      if (!token) {
        return {
          success: false,
          error: "No RelayAuth access token is configured.",
        };
      }

      const requestHeaders = new Headers(headers);
      requestHeaders.set("authorization", `Bearer ${token}`);

      const init: RequestInit = {
        method,
        headers: requestHeaders,
      };

      if (body !== undefined && method !== "GET") {
        const serialized = serializeRequestBody(body, requestHeaders);
        init.body = serialized;
      }

      const response = await fetch(url, init);
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

  protected get client(): RelayAuthClient {
    this.#client ??= new RelayAuthClient({
      baseUrl: this.#resolvedConfig.serverUrl,
      apiKey: this.#resolvedConfig.apiKey,
      token: this.#issuedToken?.accessToken ?? this.#resolvedConfig.token,
    });
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
      this.#discoveryPromise ??= fetchConfiguration(normalizedUrl);
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
  const response = await fetch(new URL(".well-known/agent-configuration", baseUrl));
  if (!response.ok) {
    throw new RelayAuthError(
      "Failed to discover RelayAuth service",
      "discovery_failed",
      response.status,
    );
  }

  return (await response.json()) as AgentConfiguration;
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
    && JSON.stringify(previous.audience ?? []) === JSON.stringify(next.audience ?? [])
  );
}
