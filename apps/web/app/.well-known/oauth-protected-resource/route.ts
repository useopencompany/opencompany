import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/billing/stripe";
import {
  OPENCOMPANY_MCP_SCOPE,
  oauthCorsHeaders,
  openCompanyMcpResource,
} from "@/lib/personal/mcp-oauth";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: oauthCorsHeaders() });
}

export async function GET() {
  return NextResponse.json(
    {
      resource: openCompanyMcpResource(),
      resource_name: "OpenCompany MCP",
      authorization_servers: [getAppUrl()],
      bearer_methods_supported: ["header"],
      scopes_supported: [OPENCOMPANY_MCP_SCOPE],
      resource_documentation: `${getAppUrl()}/docs`,
    },
    { headers: oauthCorsHeaders() },
  );
}
