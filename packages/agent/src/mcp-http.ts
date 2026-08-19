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

          const handler = createMcpHandler(
            (server) => {
              registerBrainTools(server, {
                userWorkosId,
                gatewayApiKey,
                signal: authenticatedRequest.signal,
              });
              registerWikiTool(server, {
                userWorkosId,
                gatewayApiKey,
                ...(input.wiki ? { wiki: input.wiki } : {}),
              });
            },
            {
              serverInfo: { name: MCP_SERVER_NAME, version: "0.1.0" },
              instructions:
                'Brains are knowledge stores. Retrieve curated pages with search_brain (semantic + keyword recall), then fetch full documents by id with get_document; raw evidence is opt-in with kind: "evidence". Search results include pagination: when pagination.hasMore is true, repeat the same search with all filters unchanged and offset: pagination.nextOffset. Use list_documents to enumerate a brain and get_timeline for a record\'s dated history. brain is an advanced escape hatch (doctor/help) — prefer the flat tools. Every tool takes an optional brain id; call list_brains first when the user may have more than one brain. When the user explicitly asks to save or remember content, call save_to_brain once with the faithful source content; it creates an inbox draft and queues background curation. Never save inferred preferences or conversational scratchpad content without clear user intent.',
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
