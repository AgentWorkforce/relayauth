import { tool, type Tool } from "ai";
import { z } from "zod";

import { RelayAuthAdapter } from "../adapter.js";
import type { AdapterConfig, ToolResult } from "../types.js";
import { errorResult } from "../utils.js";

const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type CoreTool = {
  description: string;
  parameters: z.ZodType;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema: Tool["inputSchema"];
};

function wrapExecute<TParams>(
  execute: (params: TParams) => Promise<ToolResult>,
): (params: TParams) => Promise<ToolResult> {
  return async (params: TParams): Promise<ToolResult> => {
    try {
      return await execute(params);
    } catch (error) {
      return errorResult(error);
    }
  };
}

function createTool<TParams extends Record<string, unknown>>(
  description: string,
  parameters: z.ZodType<TParams>,
  execute: (params: TParams) => Promise<ToolResult>,
): CoreTool {
  const wrappedExecute = wrapExecute(execute);
  const sdkTool = tool<TParams, ToolResult>({
    description,
    inputSchema: parameters,
    execute: wrappedExecute,
  });

  return {
    ...sdkTool,
    description,
    parameters,
    execute: wrappedExecute as CoreTool["execute"],
  };
}

export function createRelayAuthTools(config: AdapterConfig): Record<string, CoreTool> {
  const adapter = new RelayAuthAdapter(config);

  return {
    discover_service: createTool(
      "Fetch the RelayAuth agent configuration document for a service URL.",
      z.object({
        url: z.string().optional(),
      }),
      async (params) => adapter.discover(params.url),
    ),
    register_agent: createTool(
      "Create a RelayAuth agent identity and optionally seed it with initial scopes.",
      z.object({
        name: z.string(),
        scopes: z.array(z.string()).optional(),
        sponsor: z.string().optional(),
      }),
      async (params) => adapter.registerAgent(params.name, params.scopes, params.sponsor),
    ),
    request_scope: createTool(
      "Issue a RelayAuth access token for the current or specified agent.",
      z.object({
        scopes: z.array(z.string()),
        identityId: z.string().optional(),
      }),
      async (params) => adapter.requestScope(params.scopes, params.identityId),
    ),
    execute_with_auth: createTool(
      "Send an authenticated HTTP request using the adapter's RelayAuth bearer token.",
      z.object({
        url: z.string(),
        method: httpMethodSchema.optional().default("GET"),
        body: z.unknown().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
      async (params) => adapter.executeWithAuth(
        params.url,
        params.method,
        params.body,
        params.headers,
      ),
    ),
    check_scope: createTool(
      "Verify whether the adapter's current RelayAuth token grants a specific scope.",
      z.object({
        scope: z.string(),
      }),
      async (params) => adapter.checkScope(params.scope),
    ),
  };
}
