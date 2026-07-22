import { createMcpHandler, withMcpAuth } from "mcp-handler";
import {
  buildGoatUserMcpResourceMetadataPath,
  resolveGoatAuthKitDomain,
  userWorkosIdFromMcpAuth,
  verifyGoatMcpBearerToken,
} from "@/lib/mcp-oauth";
import { registerGoatBrainTools } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const maxDuration = 120;

// User-level MCP connector: one endpoint per user covering every brain they
// can access. The token's org_id claim is deliberately not enforced here — it
// only records which organization was active during the AuthKit flow, while
// access is authorized per brain on every tool call via workspace/brain
// membership.
async function handleMcpRequest(request: Request) {
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

      const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
      if (!gatewayApiKey) {
        return Response.json({ error: "Goat MCP is not configured." }, { status: 503 });
      }

      const handler = createMcpHandler(
        (server) => {
          registerGoatBrainTools(server, {
            userWorkosId,
            gatewayApiKey,
            signal: authenticatedRequest.signal,
          });
        },
        {
          serverInfo: {
            name: "goat",
            version: "0.1.0",
          },
          instructions:
            "Brains are knowledge stores. Retrieve with search_brain (semantic + keyword recall), then fetch full documents by id with get_document; use list_documents to enumerate a brain and get_timeline for a record's dated history. goat_brain is an advanced escape hatch (doctor/help) — prefer the flat tools. Every tool takes an optional brain id; call list_brains first when the user may have more than one brain. When the user explicitly asks to save or remember content, call save_to_brain once with the faithful source content; it creates an inbox draft and queues background curation. Never save inferred preferences or conversational scratchpad content without clear user intent.",
        },
        {
          // Empty base path serves the streamable-HTTP transport at /mcp.
          basePath: "",
          disableSse: true,
          maxDuration,
        },
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
}

export { handleMcpRequest as DELETE, handleMcpRequest as GET, handleMcpRequest as POST };
