import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatXIntegrationStatus,
  buildGoatXAuthorizationUrl,
  createGoatXIntegrationState,
  isGoatXIntegrationConfigured,
  verifyGoatXIntegrationState,
} from "@/lib/integrations/x";

const X_OAUTH_COOKIE_PATH = "/api/integrations/x";
const X_OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatXIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatXIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const start = createGoatXIntegrationState({
    userWorkosId: user.workosUserId,
    returnTo,
  });
  const state = verifyGoatXIntegrationState(start.signedState);
  const response = NextResponse.redirect(buildGoatXAuthorizationUrl(start));
  response.cookies.set(xOAuthVerifierCookieName(state.nonce), start.codeVerifier, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: X_OAUTH_COOKIE_PATH,
    maxAge: X_OAUTH_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

function xOAuthVerifierCookieName(nonce: string) {
  return `goat_x_oauth_verifier_${nonce}`;
}
