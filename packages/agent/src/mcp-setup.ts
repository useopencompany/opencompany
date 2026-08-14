export const USER_MCP_ENDPOINT_PATH = "/mcp";
export const MCP_SERVER_NAME = "opencompany";

export function isMcpSetupCompletionRun(input: {
  sourceRef: string | null | undefined;
  command: string | null | undefined;
  ok: boolean;
}) {
  return input.ok && input.command === "query" && Boolean(input.sourceRef?.startsWith("mcp:"));
}
