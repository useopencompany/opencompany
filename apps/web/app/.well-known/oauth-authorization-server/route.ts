import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/billing/stripe";
import { OPENCOMPANY_MCP_SCOPE, oauthCorsHeaders } from "@/lib/personal/mcp-oauth";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: oauthCorsHeaders() });
}

export async function GET() {
  const issuer = getAppUrl();
  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/api/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      scopes_supported: [OPENCOMPANY_MCP_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: false,
    },
    { headers: oauthCorsHeaders() },
  );
}
