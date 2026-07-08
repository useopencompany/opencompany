import {
  GOAT_MCP_METADATA_CORS_HEADERS,
  goatMcpProtectedResourceMetadata,
  resolveGoatAuthKitDomain,
} from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const authKitDomain = resolveGoatAuthKitDomain();
  if (!authKitDomain.ok) {
    return Response.json({ error: authKitDomain.error }, { status: 503 });
  }

  return Response.json(goatMcpProtectedResourceMetadata(request, authKitDomain.domain), {
    headers: {
      ...GOAT_MCP_METADATA_CORS_HEADERS,
      "Cache-Control": "max-age=3600",
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: GOAT_MCP_METADATA_CORS_HEADERS,
  });
}
