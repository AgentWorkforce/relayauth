import type { AdapterTool } from "./types.js";

export const RELAYAUTH_TOOLS: ReadonlyArray<AdapterTool> = [
  {
    name: "discover_service",
    description: "Fetch the RelayAuth agent configuration document for a service URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "Optional RelayAuth server URL to discover. Defaults to the adapter server URL.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "register_agent",
    description: "Create a RelayAuth agent identity and optionally seed it with initial scopes.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for the new agent identity.",
        },
        scopes: {
          type: "array",
          description: "Scopes to assign directly to the new identity.",
          items: {
            type: "string",
          },
        },
        sponsor: {
          type: "string",
          description: "Optional sponsor identity identifier to record in metadata.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "request_scope",
    description: "Issue a RelayAuth access token for the current or specified agent with the requested scopes.",
    parameters: {
      type: "object",
      properties: {
        scopes: {
          type: "array",
          description: "Scopes to request for the token exchange or issuance call.",
          items: {
            type: "string",
          },
        },
        identityId: {
          type: "string",
          description: "Optional identity identifier. Defaults to the current adapter identity.",
        },
      },
      required: ["scopes"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_with_auth",
    description: "Send an authenticated HTTP request using the adapter's RelayAuth bearer token.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "Destination URL for the authenticated request.",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method to use.",
          default: "GET",
        },
        body: {
          description: "Optional JSON-serializable request body.",
          type: "object",
          additionalProperties: true,
        },
        headers: {
          type: "object",
          description: "Optional additional HTTP headers.",
          additionalProperties: {
            type: "string",
          },
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "check_scope",
    description: "Verify whether the adapter's current RelayAuth token grants a specific scope.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Scope string to evaluate against the verified token claims.",
        },
      },
      required: ["scope"],
      additionalProperties: false,
    },
  },
];
