import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getGoatAppUrl } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

function privateRedirect(url: string | URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

// Resolves a workspace invitation link into our own sign-up page. The
// invitation_token itself (not organizationId) is what threads through
// lib/auth-actions.ts to WorkOS's authenticate calls, which associate the
// invitation's organization automatically once the person authenticates.
export async function GET(request: NextRequest) {
  const invitationToken = request.nextUrl.searchParams.get("invitation_token")?.trim();
  if (!invitationToken) {
    return privateRedirect(new URL("/signin", getGoatAppUrl()));
  }

  const url = new URL("/signup", getGoatAppUrl());
  url.searchParams.set("invitation_token", invitationToken);

  try {
    const invitation =
      await getWorkOSClient().userManagement.findInvitationByToken(invitationToken);
    if (invitation.state === "pending" && invitation.email) {
      url.searchParams.set("email", invitation.email);
    }
  } catch {
    // Our sign-up flow surfaces the real error when the token is exchanged;
    // don't log it here because it can contain the invitation token.
    console.warn("[goat] Could not resolve the workspace invitation before sign-up");
  }

  return privateRedirect(url);
}
