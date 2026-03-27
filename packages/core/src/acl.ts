import type { RelayConfig } from "./config.js";

export async function seedAclEntries(
  workspace: string,
  acl: Record<string, string[]>,
  baseUrl: string,
  token: string,
): Promise<void> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  // Build all ACL files and write via bulk endpoint (no If-Match required)
  const files = Object.entries(acl).map(([dirPath, rules]) => ({
    path: dirPath === "/" ? "/.relayfile.acl" : `${dirPath}/.relayfile.acl`,
    content: JSON.stringify({ semantics: { permissions: rules } }),
    encoding: "utf-8" as const,
  }));

  if (files.length === 0) return;

  const url = `${normalizedBaseUrl}/v1/workspaces/${encodeURIComponent(workspace)}/fs/bulk`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-correlation-id": `seed-acl-${Date.now()}`,
    },
    body: JSON.stringify({ files }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`failed to seed ACLs: HTTP ${response.status} ${body}`.trim());
  }

  const result = await response.json() as { errorCount: number; errors: any[] };
  if (result.errorCount > 0) {
    throw new Error(`ACL seeding had ${result.errorCount} error(s): ${JSON.stringify(result.errors)}`);
  }
}

export async function seedAcl(
  config: Pick<RelayConfig, "workspace" | "acl">,
  baseUrl: string,
  token: string,
): Promise<void> {
  await seedAclEntries(config.workspace, config.acl, baseUrl, token);
}
