import type { VerifyOptions } from "@relayauth/sdk";

export interface JSONSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  format?: string;
  default?: unknown;
  examples?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface AdapterTool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface AdapterOptions extends Partial<VerifyOptions> {
  token?: string;
  defaultScopes?: string[];
  orgId?: string;
  workspaceId?: string;
  autoIssueToken?: boolean;
  tokenExpiresIn?: number;
}

export interface AdapterConfig extends AdapterOptions {
  serverUrl: string;
  apiKey?: string;
  autoDiscover?: boolean;
  options?: AdapterOptions;
}

export interface ToolResult<TData = unknown> {
  success: boolean;
  data?: TData;
  error?: string;
}
