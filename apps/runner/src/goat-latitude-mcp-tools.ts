import { createGoatRemoteMcpTools } from "./goat-remote-mcp-tools";

export type GoatLatitudeMcpToolName = "latitude_search_tools" | "latitude_use_tool";

const latitudeMcpTools = createGoatRemoteMcpTools({
  provider: "latitude",
  displayName: "Latitude",
  endpointUrl: "https://api.latitude.so/v1/mcp",
  externalId: "latitude_mcp",
});

export function isGoatLatitudeMcpToolName(name: string): name is GoatLatitudeMcpToolName {
  return latitudeMcpTools.isToolName(name);
}

export async function executeGoatLatitudeMcpTool(input: {
  name: GoatLatitudeMcpToolName;
  args: unknown;
  userWorkosId: string;
  signal: AbortSignal;
}) {
  return latitudeMcpTools.execute(input);
}
