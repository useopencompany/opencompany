import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { setOAuthStateCookie } from "@/lib/auth-methods";
import { isValidDesktopChallenge } from "@/lib/desktop-auth";
import { getAppUrl, getWorkOSRedirectUri } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "";

// Entry point for the desktop Google sign-in flow, opened in the user's system
// browser by the Electron shell. Mirrors startGoogleAuth, but carries the PKCE
// `challenge` through the OAuth state cookie so the callback knows to hand the
// session back to the app instead of signing the browser in.
export async function GET(request: NextRequest) {
  const challenge = request.nextUrl.searchParams.get("challenge");
  const invitationToken = request.nextUrl.searchParams.get("invitation_token")?.trim();
  if (!isValidDesktopChallenge(challenge)) {
    const url = new URL("/signin", getAppUrl());
    url.searchParams.set("error", "desktop_handoff");
    return NextResponse.redirect(url);
  }

  const state = randomUUID();
  await setOAuthStateCookie({
    state,
    desktopChallenge: challenge,
    ...(invitationToken ? { invitationToken } : {}),
  });

  const url = getWorkOSClient().userManagement.getAuthorizationUrl({
    clientId: WORKOS_CLIENT_ID,
    provider: "GoogleOAuth",
    redirectUri: getWorkOSRedirectUri(),
    state,
  });
  return NextResponse.redirect(url);
}
