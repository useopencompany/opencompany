import { NextResponse } from "next/server";
import {
  exchangeAuthorizationCode,
  McpOAuthError,
  oauthCorsHeaders,
  refreshPersonalMcpAccessToken,
} from "@/lib/personal/mcp-oauth";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: oauthCorsHeaders() });
}

export async function POST(request: Request) {
  let params: URLSearchParams;
  try {
    params = await readTokenRequestParams(request);
  } catch {
    return oauthError("invalid_request", "Token request must be form-encoded or JSON.", 400);
  }

  try {
    const grantType = required(params, "grant_type");
    const clientId = required(params, "client_id");

    if (grantType === "authorization_code") {
      const response = await exchangeAuthorizationCode({
        code: required(params, "code"),
        clientId,
        redirectUri: required(params, "redirect_uri"),
        codeVerifier: required(params, "code_verifier"),
        resource: params.get("resource"),
      });
      return NextResponse.json(response, { headers: oauthCorsHeaders() });
    }

    if (grantType === "refresh_token") {
      const response = await refreshPersonalMcpAccessToken({
        refreshToken: required(params, "refresh_token"),
        clientId,
        resource: params.get("resource"),
      });
      return NextResponse.json(response, { headers: oauthCorsHeaders() });
    }

    return oauthError("unsupported_grant_type", "Unsupported grant_type.", 400);
  } catch (error) {
    if (error instanceof McpOAuthError) {
      return oauthError(error.code, error.message, error.status);
    }
    return oauthError("server_error", "Token exchange failed.", 500);
  }
}

async function readTokenRequestParams(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as unknown;
    const params = new URLSearchParams();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") params.set(key, value);
      }
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

function required(params: URLSearchParams, key: string) {
  const value = params.get(key)?.trim();
  if (!value) throw new McpOAuthError("invalid_request", `${key} is required.`);
  return value;
}

function oauthError(error: string, errorDescription: string, status: number) {
  return NextResponse.json(
    { error, error_description: errorDescription },
    { status, headers: oauthCorsHeaders() },
  );
}
