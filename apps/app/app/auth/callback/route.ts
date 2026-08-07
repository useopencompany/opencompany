import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { completeAuthentication } from "@/lib/auth";
import {
  consumeOAuthStateCookie,
  organizationSelectionFromError,
  safeReturnPathname,
  setOrganizationSelection,
} from "@/lib/auth-methods";
import { getAppUrl } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

// authkit-nextjs's getWorkOS() doesn't thread WORKOS_CLIENT_ID down into
// userManagement's per-call default, so calls made directly against the SDK
// (bypassing authkit-nextjs's own callback handler) need it passed explicitly.
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? "";

function signInErrorRedirect(reason: string) {
  const url = new URL("/signin", getAppUrl());
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

// Handles the Google OAuth leg of our custom sign-in/sign-up UI. We don't use
// authkit-nextjs's handleAuth()/getSignInUrl() here because those are wired to
// the hosted AuthKit picker (provider: "authkit"); this route instead pairs
// with lib/auth-actions.ts's startGoogleAuth, which targets GoogleOAuth
// directly and stores its own CSRF state cookie.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const statePayload = await consumeOAuthStateCookie();

  if (!code || !state || !statePayload || state !== statePayload.state) {
    return signInErrorRedirect("oauth_state");
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = request.headers.get("user-agent") ?? undefined;

  try {
    const authResponse = await getWorkOSClient().userManagement.authenticateWithCode({
      clientId: WORKOS_CLIENT_ID,
      code,
      ...(statePayload.invitationToken ? { invitationToken: statePayload.invitationToken } : {}),
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
    await completeAuthentication(authResponse, request);
    return NextResponse.redirect(
      new URL(safeReturnPathname(statePayload.returnPathname), getAppUrl()),
    );
  } catch (error) {
    const selection = organizationSelectionFromError(error);
    if (selection) {
      await setOrganizationSelection({
        ...selection,
        returnPathname: safeReturnPathname(statePayload.returnPathname),
      });
      return NextResponse.redirect(new URL("/signin", getAppUrl()));
    }
    console.error("[app] Failed to complete Google sign-in", error);
    return signInErrorRedirect("oauth_failed");
  }
}
