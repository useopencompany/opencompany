// One connector per user: this endpoint spans every brain the signed-in user
// can access. Kept here (client-safe) and reused by lib/mcp-oauth.ts.
export {
  GOAT_USER_MCP_ENDPOINT_PATH,
  isGoatMcpSetupCompletionRun,
  OPENCOMPANY_MCP_SERVER_NAME,
} from "@opencompany/goat-agent/mcp-setup";

// Mirrors the protocol's McpClient enum with a concrete web-side union: the
// generated z.infer types collapse to `any` under this app's tsconfig.
export const GOAT_MCP_CLIENTS = ["claude", "chatgpt", "cursor"] as const;

export type GoatMcpClient = (typeof GOAT_MCP_CLIENTS)[number];

export function isGoatMcpClient(value: unknown): value is GoatMcpClient {
  return typeof value === "string" && GOAT_MCP_CLIENTS.some((client) => client === value);
}

export function buildGoatMcpFirstPrompt(input: { displayName: string; workspaceName: string }) {
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
