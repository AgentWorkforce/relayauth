type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
type ScopeAction = "read" | "write" | "delete";
type ApprovalMode = "session" | "explicit";

export interface OpenAPIOperation {
  summary?: string;
  "x-relayauth-scope"?: string;
}

export interface OpenAPIPathItem
  extends Partial<Record<HttpMethod, OpenAPIOperation>> {}

export interface OpenAPISpec {
  info: {
    title: string;
  };
  paths: Record<string, OpenAPIPathItem>;
  openapi?: string;
}

export interface ScopeDefinition {
  scope: string;
  description: string;
  method: string;
  path: string;
  approval: ApprovalMode;
}

const METHOD_ORDER: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];

const METHOD_TO_ACTION: Record<HttpMethod, ScopeAction> = {
  get: "read",
  post: "write",
  put: "write",
  patch: "write",
  delete: "delete",
};

const METHOD_TO_APPROVAL: Record<HttpMethod, ApprovalMode> = {
  get: "session",
  post: "explicit",
  put: "explicit",
  patch: "explicit",
  delete: "explicit",
};

function toKebabCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function isPathParameter(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function deriveResource(path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0 && !isPathParameter(segment));

  return segments.join(".") || "root";
}

function shouldAppendPath(method: HttpMethod, path: string): boolean {
  if (method === "put" || method === "patch" || method === "delete") {
    return path.includes("{");
  }

  return false;
}

function buildScope(
  service: string,
  method: HttpMethod,
  path: string,
  operation: OpenAPIOperation,
): string {
  if (operation["x-relayauth-scope"]) {
    const override = operation["x-relayauth-scope"];
    const segments = override.split(":");
    if (segments.length < 3) {
      throw new Error(
        `Invalid x-relayauth-scope "${override}" on ${method.toUpperCase()} ${path}: must have at least 3 colon-separated segments ({service}:{resource}:{action})`,
      );
    }
    return override;
  }

  const resource = deriveResource(path);
  const action = METHOD_TO_ACTION[method];

  if (shouldAppendPath(method, path)) {
    return `${service}:${resource}:${action}:${path}`;
  }

  return `${service}:${resource}:${action}`;
}

export function generateScopes(
  spec: OpenAPISpec,
  serviceName?: string,
): ScopeDefinition[] {
  const service = toKebabCase(serviceName ?? spec.info.title) || "api";
  const definitions: ScopeDefinition[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of METHOD_ORDER) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      definitions.push({
        scope: buildScope(service, method, path, operation),
        description: operation.summary ?? "",
        method: method.toUpperCase(),
        path,
        approval: METHOD_TO_APPROVAL[method],
      });
    }
  }

  return definitions;
}
