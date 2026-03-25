import type {
  AgentIdentity,
  AuditEntry,
  AuditQuery,
  CreateIdentityInput,
  IdentityStatus,
  TokenPair,
} from "@relayauth/types";

import {
  IdentityNotFoundError,
  IdentitySuspendedError,
  InsufficientScopeError,
  InvalidScopeError,
  RelayAuthError,
  TokenExpiredError,
  TokenRevokedError,
} from "./errors.js";

export interface RelayAuthClientOptions {
  baseUrl: string;
  apiKey?: string;
  token?: string;
}

type ListIdentitiesOptions = {
  limit?: number;
  cursor?: string;
  status?: IdentityStatus;
};

type RequestOptions = Omit<RequestInit, "body" | "headers"> & {
  body?: unknown;
  headers?: HeadersInit;
  query?: Record<string, string | number | undefined>;
};

export class RelayAuthClient {
  declare private readonly __types?: {
    tokenPair: TokenPair;
    identity: AgentIdentity;
    createIdentityInput: CreateIdentityInput;
    auditQuery: AuditQuery;
    auditEntry: AuditEntry;
  };

  readonly options: RelayAuthClientOptions;

  constructor(options: RelayAuthClientOptions) {
    this.options = options;
  }

  async createIdentity(orgId: string, input: CreateIdentityInput): Promise<AgentIdentity> {
    return this._request<AgentIdentity>("/v1/identities", {
      method: "POST",
      body: {
        orgId,
        ...input,
      },
    });
  }

  async getIdentity(identityId: string): Promise<AgentIdentity> {
    return this._request<AgentIdentity>(`/v1/identities/${encodeURIComponent(identityId)}`);
  }

  async listIdentities(
    orgId: string,
    options?: ListIdentitiesOptions,
  ): Promise<{ identities: AgentIdentity[]; cursor?: string }> {
    const response = await this._request<{ data: AgentIdentity[]; cursor?: string }>(
      "/v1/identities",
      {
        query: {
          orgId,
          limit: options?.limit,
          cursor: options?.cursor,
          status: options?.status,
        },
      },
    );

    return {
      identities: response.data,
      cursor: response.cursor,
    };
  }

  async updateIdentity(
    identityId: string,
    updates: Partial<CreateIdentityInput>,
  ): Promise<AgentIdentity> {
    return this._request<AgentIdentity>(`/v1/identities/${encodeURIComponent(identityId)}`, {
      method: "PATCH",
      body: updates,
    });
  }

  async suspendIdentity(identityId: string, reason: string): Promise<AgentIdentity> {
    return this._request<AgentIdentity>(
      `/v1/identities/${encodeURIComponent(identityId)}/suspend`,
      {
        method: "POST",
        body: { reason },
      },
    );
  }

  async reactivateIdentity(identityId: string): Promise<AgentIdentity> {
    return this._request<AgentIdentity>(
      `/v1/identities/${encodeURIComponent(identityId)}/reactivate`,
      {
        method: "POST",
      },
    );
  }

  async retireIdentity(identityId: string): Promise<AgentIdentity> {
    return this._request<AgentIdentity>(`/v1/identities/${encodeURIComponent(identityId)}/retire`, {
      method: "POST",
    });
  }

  async deleteIdentity(identityId: string): Promise<void> {
    await this._request<void>(`/v1/identities/${encodeURIComponent(identityId)}`, {
      method: "DELETE",
      headers: {
        "X-Confirm-Delete": "true",
      },
    });
  }

  private async _request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { body, headers, query, ...init } = options;
    const url = new URL(path, normalizeBaseUrl(this.options.baseUrl));

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const requestHeaders = new Headers(headers);

    if (this.options.token) {
      requestHeaders.set("authorization", `Bearer ${this.options.token}`);
    }

    if (this.options.apiKey) {
      requestHeaders.set("x-api-key", this.options.apiKey);
    }

    let requestBody: BodyInit | undefined;
    if (body !== undefined) {
      requestHeaders.set("content-type", "application/json");
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(url, {
      ...init,
      headers: requestHeaders,
      body: requestBody,
    });

    const text = await response.text();
    const payload = text ? parseJson(text) : undefined;

    if (!response.ok) {
      throw createRequestError(response.status, path, payload);
    }

    if (!text) {
      return undefined as T;
    }

    return payload as T;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function createRequestError(status: number, path: string, payload: unknown): RelayAuthError {
  const identityId = extractIdentityId(path);
  const errorCode = getString(payload, "error");
  const message = getString(payload, "message") ?? `Request failed with status ${status}`;

  if (status === 404 && identityId) {
    return new IdentityNotFoundError(identityId);
  }

  if (status === 403) {
    if (errorCode === "insufficient_scope") {
      return new InsufficientScopeError(
        getString(payload, "required") ?? "unknown",
        getStringArray(payload, "actual"),
      );
    }

    if (identityId) {
      return new IdentitySuspendedError(identityId);
    }
  }

  if (status === 401) {
    if (errorCode === "token_revoked") {
      return new TokenRevokedError();
    }

    if (errorCode === "token_expired") {
      return new TokenExpiredError();
    }
  }

  if (status === 400 && errorCode === "invalid_scope") {
    return new InvalidScopeError(getString(payload, "scope") ?? "unknown", getString(payload, "reason"));
  }

  return new RelayAuthError(message, errorCode ?? "request_failed", status);
}

function extractIdentityId(path: string): string | undefined {
  const match = /^\/v1\/identities\/([^/]+)/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" ? entry : undefined;
}

function getStringArray(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const entry = (value as Record<string, unknown>)[key];
  return Array.isArray(entry) && entry.every((item) => typeof item === "string") ? entry : [];
}
