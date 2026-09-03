import {
  getLegacyBrainAccessForUser,
  markMcpSetupCompletedForUser,
} from "@opencompany/db/workspaces";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import {
  buildUserMcpResourceMetadataPath,
  resolveAuthKitDomain,
  userWorkosIdFromMcpAuth,
  verifyMcpBearerToken,
} from "./mcp-oauth";
import { type McpWikiGateway, registerBrainTools, registerWikiTool } from "./mcp-server";
import { MCP_SERVER_NAME } from "./mcp-setup";

const MCP_MAX_DURATION_SECONDS = 120;

export type McpService = {
  handle(request: Request): Promise<Response>;
};

export function createMcpService(input: {
  gatewayApiKey?: string;
  wiki?: McpWikiGateway;
}): McpService {
  return {
    async handle(request) {
      const authConfig = resolveAuthKitDomain();
      if (!authConfig.ok) {
        return Response.json({ error: authConfig.error }, { status: 503 });
      }

      const authHandler = withMcpAuth(
        async (authenticatedRequest) => {
          const userWorkosId = userWorkosIdFromMcpAuth(authenticatedRequest.auth);
          if (!userWorkosId) {
            return Response.json({ error: "Invalid MCP authentication context." }, { status: 401 });
          }

          const gatewayApiKey = input.gatewayApiKey?.trim();
          if (!gatewayApiKey) {
            return Response.json({ error: "opencompany MCP is not configured." }, { status: 503 });
          }
          const legacyBrainEnabled = (await getLegacyBrainAccessForUser(userWorkosId)).length > 0;

          const handler = createMcpHandler(
            (server) => {
              if (legacyBrainEnabled) {
                registerBrainTools(server, {
                  userWorkosId,
                  gatewayApiKey,
                  signal: authenticatedRequest.signal,
                });
              }
              registerWikiTool(server, {
                userWorkosId,
                gatewayApiKey,
                ...(input.wiki ? { wiki: input.wiki } : {}),
                onSuccessfulWikiCall: () => markMcpSetupCompletedForUser(userWorkosId),
              });
            },
            {
              serverInfo: { name: MCP_SERVER_NAME, version: "0.1.0" },
              instructions: legacyBrainEnabled
                ? "The workspace wiki is the primary knowledge system; use wiki tree/read/search for recall and wiki write for explicit knowledge updates. Legacy Brain tools are also available for workspaces that opted in: use search_brain/get_document for reads and save_to_brain only when the user explicitly asks to save there."
                : "The workspace wiki is the knowledge system. Start with wiki tree, read promising pages, use search for recall, and write only when the user explicitly asks to update durable knowledge.",
            },
            { basePath: "", disableSse: true, maxDuration: MCP_MAX_DURATION_SECONDS },
          );
          return handler(authenticatedRequest);
        },
        verifyMcpBearerToken,
        {
          required: true,
          resourceMetadataPath: buildUserMcpResourceMetadataPath(),
        },
      );

      return authHandler(request);
    },
  };
}
