import type { McpClient } from "@opencompany/db/schema";

// One connector per user: this endpoint spans every brain the signed-in user
// can access. Kept here (client-safe) and reused by lib/mcp-oauth.ts.
export const GOAT_USER_MCP_ENDPOINT_PATH = "/mcp";
export const OPENCOMPANY_MCP_SERVER_NAME = "opencompany";

export const GOAT_MCP_CLIENTS = [
  "claude",
  "chatgpt",
  "cursor",
] as const satisfies readonly McpClient[];

export function isMcpClient(value: unknown): value is McpClient {
  return typeof value === "string" && GOAT_MCP_CLIENTS.some((client) => client === value);
}

export function isMcpSetupCompletionRun(input: {
  sourceRef: string | null | undefined;
  command: string | null | undefined;
  ok: boolean;
}) {
  return input.ok && input.command === "query" && Boolean(input.sourceRef?.startsWith("mcp:"));
}

export function buildMcpFirstPrompt(input: { displayName: string; workspaceName: string }) {
  return [
    "Use the OpenCompany connector for this entire answer.",
    `First list my brains, then query for "${input.displayName}".`,
    `Then brief me on the active projects, recent decisions, and people most relevant to my work at ${input.workspaceName}.`,
    "Cite the brain pages you used.",
    "If the brain has little about me, say so and give me the most important recent workspace brief instead.",
  ].join(" ");
}

export function buildCursorMcpConfig(input: { name: string; url: string }) {
  return {
    mcpServers: {
      [input.name]: {
        url: input.url,
      },
    },
  };
}

export function buildCursorMcpDeeplink(input: { name: string; url: string }) {
  const config = JSON.stringify({ url: input.url });
  const bytes = new TextEncoder().encode(config);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encodedConfig = btoa(binary);
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(input.name)}&config=${encodeURIComponent(encodedConfig)}`;
}
