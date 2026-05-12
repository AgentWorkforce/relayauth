import type { AgentTokenIssueRequest, AgentTokenPair, TokenPair } from "@relayauth/types";

import { TokenExpiredError, TokenRevokedError } from "./errors.js";
import type { RelayAuthClient } from "./client.js";

const DEFAULT_REFRESH_WINDOW_MS = 60_000;

export interface AgentTokenSessionOptions extends AgentTokenIssueRequest {
  client: RelayAuthClient;
  refreshWindowMs?: number;
}

export class AgentTokenSession {
  readonly client: RelayAuthClient;
  readonly refreshWindowMs: number;

  #issueRequest: AgentTokenIssueRequest;
  #current?: AgentTokenPair;
  #inflight?: Promise<AgentTokenPair>;

  constructor(options: AgentTokenSessionOptions) {
    this.client = options.client;
    this.refreshWindowMs = normalizeRefreshWindowMs(options.refreshWindowMs);
    this.#issueRequest = {
      agentId: options.agentId,
      ...(options.scopes ? { scopes: [...options.scopes] } : {}),
      ...(options.audience ? { audience: [...options.audience] } : {}),
      ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
    };
  }

  peek(): AgentTokenPair | undefined {
    return this.#current ? cloneAgentTokenPair(this.#current) : undefined;
  }

  async getAccessToken(): Promise<string> {
    const tokenPair = await this.getTokenPair();
    return tokenPair.accessToken;
  }

  async getTokenPair(): Promise<AgentTokenPair> {
    if (!this.#inflight) {
      this.#inflight = this.#ensureFreshTokenPair().finally(() => {
        this.#inflight = undefined;
      });
    }

    return this.#inflight;
  }

  async forceRefresh(): Promise<AgentTokenPair> {
    if (!this.#inflight) {
      this.#inflight = this.#rotateTokenPair().finally(() => {
        this.#inflight = undefined;
      });
    }

    return this.#inflight;
  }

  async #ensureFreshTokenPair(): Promise<AgentTokenPair> {
    if (!this.#current) {
      return this.#issueTokenPair();
    }

    if (shouldRotate(this.#current.accessTokenExpiresAt, this.refreshWindowMs)) {
      return this.#rotateTokenPair();
    }

    return cloneAgentTokenPair(this.#current);
  }

  async #rotateTokenPair(): Promise<AgentTokenPair> {
    if (!this.#current || shouldRotate(this.#current.refreshTokenExpiresAt, this.refreshWindowMs)) {
      return this.#issueTokenPair();
    }

    try {
      const refreshed = await this.client.refreshToken(this.#current.refreshToken);
      const next = mergeAgentTokenPair(this.#current, refreshed);
      this.#current = next;
      return cloneAgentTokenPair(next);
    } catch (error) {
      if (error instanceof TokenExpiredError || error instanceof TokenRevokedError) {
        return this.#issueTokenPair();
      }
      throw error;
    }
  }

  async #issueTokenPair(): Promise<AgentTokenPair> {
    const issued = await this.client.issueAgentToken(this.#issueRequest);
    this.#current = cloneAgentTokenPair(issued);
    return cloneAgentTokenPair(issued);
  }
}

export function createAgentTokenSession(options: AgentTokenSessionOptions): AgentTokenSession {
  return new AgentTokenSession(options);
}

function mergeAgentTokenPair(current: AgentTokenPair, refreshed: TokenPair): AgentTokenPair {
  return {
    ...refreshed,
    agentId: current.agentId,
    workspaceId: current.workspaceId,
    tokenClass: current.tokenClass,
    issuedViaWorkspaceTokenId: current.issuedViaWorkspaceTokenId,
  };
}

function cloneAgentTokenPair(tokenPair: AgentTokenPair): AgentTokenPair {
  return {
    ...tokenPair,
  };
}

function normalizeRefreshWindowMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_REFRESH_WINDOW_MS;
  }

  return Math.floor(value);
}

function shouldRotate(expiresAt: string, refreshWindowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }

  return expiresAtMs - Date.now() <= refreshWindowMs;
}
