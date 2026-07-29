import { createGoatRemoteMcpTools } from "./goat-remote-mcp-tools";

export type GoatLinearMcpToolName = "linear_search_tools" | "linear_use_tool";

const linearMcpTools = createGoatRemoteMcpTools({
  provider: "linear",
  displayName: "Linear",
  endpointUrl: "https://mcp.linear.app/mcp",
  externalId: "linear_mcp",
  authScope: "read write",
});

export function isGoatLinearMcpToolName(name: string): name is GoatLinearMcpToolName {
  return linearMcpTools.isToolName(name);
}

export async function executeGoatLinearMcpTool(input: {
  name: GoatLinearMcpToolName;
  args: unknown;
  userWorkosId: string;
  signal: AbortSignal;
}) {
  return linearMcpTools.execute(input);
}
