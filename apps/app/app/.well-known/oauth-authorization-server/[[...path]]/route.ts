import { MCP_METADATA_CORS_HEADERS, resolveAuthKitDomain } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  const authKitDomain = resolveAuthKitDomain();
  if (!authKitDomain.ok) {
    return Response.json({ error: authKitDomain.error }, { status: 503 });
  }

  const metadataUrl = new URL("/.well-known/oauth-authorization-server", authKitDomain.domain);
  const response = await fetch(metadataUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.text();

  return new Response(body, {
    status: response.status,
    headers: {
      ...MCP_METADATA_CORS_HEADERS,
      "Cache-Control": response.headers.get("Cache-Control") ?? "max-age=3600",
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: MCP_METADATA_CORS_HEADERS,
  });
}
