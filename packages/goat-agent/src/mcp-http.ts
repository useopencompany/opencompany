import { createMcpHandler, withMcpAuth } from "mcp-handler";
import {
  buildGoatUserMcpResourceMetadataPath,
  resolveGoatAuthKitDomain,
  userWorkosIdFromMcpAuth,
  verifyGoatMcpBearerToken,
} from "./mcp-oauth";
import { registerGoatBrainTools, registerGoatWikiTool } from "./mcp-server";
import { OPENCOMPANY_MCP_SERVER_NAME } from "./mcp-setup";

const MCP_MAX_DURATION_SECONDS = 120;

export type GoatMcpService = {
  handle(request: Request): Promise<Response>;
};

export function createGoatMcpService(input: { gatewayApiKey?: string }): GoatMcpService {
  return {
    async handle(request) {
      const authConfig = resolveGoatAuthKitDomain();
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
            return Response.json({ error: "OpenCompany MCP is not configured." }, { status: 503 });
          }

          const handler = createMcpHandler(
            (server) => {
              registerGoatBrainTools(server, {
                userWorkosId,
                gatewayApiKey,
                signal: authenticatedRequest.signal,
              });
              registerGoatWikiTool(server, { userWorkosId, gatewayApiKey });
            },
            {
              serverInfo: { name: OPENCOMPANY_MCP_SERVER_NAME, version: "0.1.0" },
              instructions:
                'Brains are knowledge stores. Retrieve curated pages with search_brain (semantic + keyword recall), then fetch full documents by id with get_document; raw evidence is opt-in with kind: "evidence". Search results include pagination: when pagination.hasMore is true, repeat the same search with all filters unchanged and offset: pagination.nextOffset. Use list_documents to enumerate a brain and get_timeline for a record\'s dated history. goat_brain is an advanced escape hatch (doctor/help) — prefer the flat tools. Every tool takes an optional brain id; call list_brains first when the user may have more than one brain. When the user explicitly asks to save or remember content, call save_to_brain once with the faithful source content; it creates an inbox draft and queues background curation. Never save inferred preferences or conversational scratchpad content without clear user intent.',
            },
            { basePath: "", disableSse: true, maxDuration: MCP_MAX_DURATION_SECONDS },
          );
          return handler(authenticatedRequest);
        },
        verifyGoatMcpBearerToken,
        {
          required: true,
          resourceMetadataPath: buildGoatUserMcpResourceMetadataPath(),
        },
      );

      return authHandler(request);
    },
  };
}
