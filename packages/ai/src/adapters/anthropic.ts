import { RelayAuthAdapter } from "../adapter.js";
import { RELAYAUTH_TOOLS } from "../tools.js";
import type { AdapterConfig, JSONSchema, ToolResult } from "../types.js";

type AnthropicInputSchema = JSONSchema & {
  type: "object";
  properties: Record<string, JSONSchema>;
  required?: string[];
};

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: AnthropicInputSchema;
}

export interface ToolResultContent {
  type: "text";
  text: string;
}

type AnthropicToolUseResult = {
  content: ToolResultContent[];
  is_error?: boolean;
};

type ToolHandler = {
  tools: AnthropicTool[];
  handleToolUse: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<AnthropicToolUseResult>;
};

function errorResult(error: unknown): ToolResult {
  if (error instanceof Error) {
    return {
      success: false,
      error: error.message,
    };
  }

  return {
    success: false,
    error: "Unknown error",
  };
}

function toToolUseResult(result: ToolResult): AnthropicToolUseResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    ...(result.success ? {} : { is_error: true }),
  };
}

export function createAnthropicTools(_config: AdapterConfig): AnthropicTool[] {
  return RELAYAUTH_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: structuredClone(tool.parameters) as AnthropicInputSchema,
  }));
}

export function createToolHandler(config: AdapterConfig): ToolHandler {
  const adapter = new RelayAuthAdapter(config);
  const tools = createAnthropicTools(config);

  return {
    tools,
    async handleToolUse(
      name: string,
      input: Record<string, unknown>,
    ): Promise<AnthropicToolUseResult> {
      try {
        const result = await adapter.executeTool(name, input);
        return toToolUseResult(result);
      } catch (error) {
        return toToolUseResult(errorResult(error));
      }
    },
  };
}
