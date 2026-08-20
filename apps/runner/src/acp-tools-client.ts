import type { AcpMcpServer } from "./acp-harness";

export const ACP_TOOLS_MCP_SERVER_NAME = "opencompany";
export const ACP_TOOLS_GATEWAY_PATH = "/internal/goat/acp-tools";
export const ACP_TOOLS_TICKET_HEADER = "x-opencompany-tool-ticket";

export function buildAcpToolsMcpServers(input: {
  runnerPublicUrl: string | undefined;
  ticket: string;
}): AcpMcpServer[] {
  if (!input.runnerPublicUrl) throw new Error("runnerPublicUrl is required to enable ACP tools.");
  return [
    {
      name: ACP_TOOLS_MCP_SERVER_NAME,
      type: "http",
      url: new URL(ACP_TOOLS_GATEWAY_PATH, input.runnerPublicUrl).toString(),
      headers: [{ name: ACP_TOOLS_TICKET_HEADER, value: input.ticket }],
    },
  ];
}
