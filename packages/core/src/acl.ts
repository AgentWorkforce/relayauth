import type { RelayConfig } from "./config.js";

export async function seedAclEntries(
  workspace: string,
  acl: Record<string, string[]>,
  baseUrl: string,
  token: string,
): Promise<void> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  for (const [dirPath, rules] of Object.entries(acl)) {
    const aclPath = dirPath === "/" ? "/.relayfile.acl" : `${dirPath}/.relayfile.acl`;
    const url = new URL(
      `${normalizedBaseUrl}/v1/workspaces/${encodeURIComponent(workspace)}/fs/file`,
    );
    url.searchParams.set("path", aclPath);

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: JSON.stringify({ semantics: { permissions: rules } }),
        encoding: "utf-8",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`failed to seed ACL for ${dirPath}: HTTP ${response.status} ${body}`.trim());
    }
  }
}

export async function seedAcl(
  config: Pick<RelayConfig, "workspace" | "acl">,
  baseUrl: string,
  token: string,
): Promise<void> {
  await seedAclEntries(config.workspace, config.acl, baseUrl, token);
}
