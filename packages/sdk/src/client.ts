import type {
  AgentIdentity,
  AuditEntry,
  AuditQuery,
  CreateIdentityInput,
  TokenPair,
} from "@relayauth/types";

export interface RelayAuthClientOptions {
  baseUrl: string;
  apiKey?: string;
  token?: string;
}

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

  // Methods added by subsequent workflows
}
