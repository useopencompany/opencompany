import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import {
  createPersonalMcpAuthorizationCode,
  McpOAuthError,
  oauthCorsHeaders,
  validateAuthorizeRequest,
} from "@/lib/personal/mcp-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);

  let authorization;
  try {
    authorization = await validateAuthorizeRequest(url);
  } catch (error) {
    const message = error instanceof McpOAuthError ? error.message : "Invalid OAuth request.";
    return oauthHtml("OpenCompany OAuth request rejected", `<p>${escapeHtml(message)}</p>`, 400);
  }

  const current = await currentWorkspace({ skipOnboarding: true });

  if (url.searchParams.get("consent") !== "accept") {
    return oauthHtml(
      "Connect OpenCompany MCP",
      [
        `<p><strong>${escapeHtml(authorization.client.clientName)}</strong> wants read-only access to your OpenCompany personal memory and Personal Brain.</p>`,
        `<form method="get" action="/api/oauth/authorize">`,
        hiddenInputs(url.searchParams),
        `<input type="hidden" name="consent" value="accept" />`,
        `<button type="submit">Authorize</button>`,
        `</form>`,
      ].join("\n"),
    );
  }

  const code = await createPersonalMcpAuthorizationCode({
    clientId: authorization.client.clientId,
    workspaceId: current.workspace.id,
    userId: current.user.id,
    redirectUri: authorization.redirectUri,
    scope: authorization.scope,
    codeChallenge: authorization.codeChallenge,
    codeChallengeMethod: authorization.codeChallengeMethod,
    resource: authorization.resource,
  });

  const redirect = new URL(authorization.redirectUri);
  redirect.searchParams.set("code", code);
  if (authorization.state) redirect.searchParams.set("state", authorization.state);
  return NextResponse.redirect(redirect, { headers: oauthCorsHeaders() });
}

function oauthHtml(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(420px, calc(100vw - 32px)); }
    h1 { font-size: 22px; margin: 0 0 12px; letter-spacing: 0; }
    p { line-height: 1.5; margin: 0 0 20px; color: color-mix(in srgb, CanvasText 78%, transparent); }
    button { border: 0; border-radius: 8px; padding: 10px 14px; font: inherit; font-weight: 600; background: CanvasText; color: Canvas; cursor: pointer; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`,
    {
      status,
      headers: {
        ...oauthCorsHeaders(),
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

function hiddenInputs(params: URLSearchParams) {
  return [...params.entries()]
    .filter(([key]) => key !== "consent")
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`,
    )
    .join("\n");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
