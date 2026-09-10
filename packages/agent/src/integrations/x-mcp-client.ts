import { createMCPClient } from "@ai-sdk/mcp";
import type { RemoteMcpGatewayDependencies } from "../actions/remote-mcp";
import type { XAccessConnection } from "./x-access-token";
import { executeXApiTool, X_API_TOOLS, xApiToolDefinitions } from "./x-api-tools";

type CreateClient = RemoteMcpGatewayDependencies["createClient"];

// Supplemental REST calls stay inside the existing gateway's permission, account,
// and audit boundary. Laziness keeps publishing independent of hosted MCP uptime.
export function createXMcpClient(input: {
  connection: XAccessConnection;
  createRemoteClient?: CreateClient;
  executeApiTool?: typeof executeXApiTool;
}): CreateClient {
  return async (config) => {
    let remote: ReturnType<CreateClient> | undefined;
    const getRemote = (): ReturnType<CreateClient> =>
      (remote ??= (input.createRemoteClient ?? createMCPClient)(config));
    const definitions = xApiToolDefinitions();
    const names = new Set(X_API_TOOLS.map((tool) => tool.name));
    let preload:
      | Parameters<Awaited<ReturnType<CreateClient>>["toolsFromDefinitions"]>[0]
      | undefined;
    return {
      listTools: async (request) => {
        const result = await (await getRemote()).listTools(request);
        return {
          ...result,
          tools: [
            ...result.tools.filter((tool) => !names.has(tool.name)),
            ...(!request?.params?.cursor ? definitions : []),
          ],
        };
      },
      toolsFromDefinitions: (request) => {
        preload = request;
      },
      callTool: async (request) => {
        if (names.has(request.name)) {
          const result = await (input.executeApiTool ?? executeXApiTool)({
            name: request.name,
            params: request.arguments ?? {},
            connection: input.connection,
            signal: request.options?.signal,
          });
          return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
        }
        const client = await getRemote();
        if (preload) client.toolsFromDefinitions(preload);
        return client.callTool(request);
      },
      close: async () => {
        if (remote) await (await remote).close();
      },
    };
  };
}
