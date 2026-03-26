import type { ToolResult } from "./types.js";

export function errorResult(error: unknown): ToolResult {
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
