import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { completeAuthentication } from "@/lib/auth";
import { recordLastAuthMethod } from "@/lib/auth-methods";
import { redeemDesktopHandoffToken } from "@/lib/desktop-auth";
import { getAppUrl } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "";

function handoffErrorRedirect() {
  const url = new URL("/signin", getAppUrl());
  url.searchParams.set("error", "desktop_handoff");
  return NextResponse.redirect(url);
}

// Loaded by the desktop app in its own window once it receives the handoff deep
// link. Redeeming the sealed token (which requires the app's private verifier)
// exchanges the WorkOS refresh token for a real session in this Electron
// session — establishing wos-session, identity sync, and workspace cookies.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const verifier = request.nextUrl.searchParams.get("verifier");
  if (!token || !verifier) {
    return handoffErrorRedirect();
  }

  try {
    const sealed = redeemDesktopHandoffToken(token, verifier);
    const authResponse = await getWorkOSClient().userManagement.authenticateWithRefreshToken({
      clientId: WORKOS_CLIENT_ID,
      refreshToken: sealed.refreshToken,
    });
    await completeAuthentication(authResponse, request);
    // Refresh-token responses don't carry authenticationMethod, so
    // completeAuthentication can't record it; set it explicitly from the token.
    await recordLastAuthMethod(sealed.authMethod);
    return NextResponse.redirect(new URL("/", getAppUrl()));
  } catch (error) {
    console.error("[opencompany] Failed to complete desktop auth handoff", error);
    return handoffErrorRedirect();
  }
}
