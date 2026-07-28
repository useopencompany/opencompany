import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getGoatWorkOSRedirectUri } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

function privateRedirect(url: string | URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest) {
  const invitationToken = request.nextUrl.searchParams.get("invitation_token")?.trim();
  if (!invitationToken) {
    return privateRedirect(new URL("/auth/sign-in", request.url));
  }

  let organizationId: string | undefined;
  let loginHint: string | undefined;
  try {
    const invitation =
      await getWorkOSClient().userManagement.findInvitationByToken(invitationToken);
    if (invitation.state === "pending") {
      organizationId = invitation.organizationId ?? undefined;
      loginHint = invitation.email;
    }
  } catch {
    // AuthKit remains the source of truth for invalid or expired tokens and
    // provides the user-facing error after the redirect below.
    // Do not log the WorkOS error because it can contain the invitation token.
    console.warn("[goat] Could not resolve the workspace invitation before sign-in");
  }

  const authorizationUrl = new URL(
    await getSignInUrl({
      redirectUri: getGoatWorkOSRedirectUri(),
      ...(organizationId ? { organizationId } : {}),
      ...(loginHint ? { loginHint } : {}),
    }),
  );
  // authkit-nextjs does not expose invitationToken in its sign-in options, but WorkOS's
  // authorization endpoint supports it. Preserve the SDK's PKCE/state URL and
  // add only the invitation selector.
  authorizationUrl.searchParams.set("invitation_token", invitationToken);

  return privateRedirect(authorizationUrl);
}
