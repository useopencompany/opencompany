import { NextResponse } from "next/server";
import {
  McpOAuthError,
  oauthCorsHeaders,
  registerPersonalMcpOAuthClient,
} from "@/lib/personal/mcp-oauth";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: oauthCorsHeaders() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "Request body must be valid JSON.", 400);
  }

  try {
    const client = await registerPersonalMcpOAuthClient(isRecord(body) ? body : {});
    return NextResponse.json(client, { status: 201, headers: oauthCorsHeaders() });
  } catch (error) {
    if (error instanceof McpOAuthError) {
      return oauthError(error.code, error.message, error.status);
    }
    return oauthError("server_error", "Could not register OAuth client.", 500);
  }
}

function oauthError(error: string, errorDescription: string, status: number) {
  return NextResponse.json(
    { error, error_description: errorDescription },
    { status, headers: oauthCorsHeaders() },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
