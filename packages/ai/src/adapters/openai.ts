import { RelayAuthAdapter } from "../adapter.js";
import { RELAYAUTH_TOOLS } from "../tools.js";
import type { AdapterConfig, ToolResult } from "../types.js";
import { errorResult } from "../utils.js";

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

type ToolHandler = {
  tools: ChatCompletionTool[];
  handleToolCall: (name: string, args: string) => Promise<string>;
};

function parseArguments(args: string): Record<string, unknown> {
  if (!args.trim()) {
    return {};
  }

  const parsed = JSON.parse(args) as unknown;
  if (parsed == null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool arguments must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

export function createOpenAITools(_config?: AdapterConfig): ChatCompletionTool[] {
  return RELAYAUTH_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function createToolHandler(config: AdapterConfig): ToolHandler {
  const adapter = new RelayAuthAdapter(config);
  const tools = createOpenAITools(config);

  return {
    tools,
    async handleToolCall(name: string, args: string): Promise<string> {
      try {
        const params = parseArguments(args);
        const result = await adapter.executeTool(name, params);
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify(errorResult(error));
      }
    },
  };
}
