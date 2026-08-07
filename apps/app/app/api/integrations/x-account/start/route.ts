import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendXAccountIntegrationStatus,
  buildXAccountAuthorizationUrl,
  createXAccountIntegrationState,
  createXAccountPkce,
  isXAccountIntegrationConfigured,
} from "@/lib/integrations/x-account";
import { setXAccountPkceCookie } from "@/lib/integrations/x-account-pkce";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isXAccountIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendXAccountIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createXAccountIntegrationState({
    userWorkosId: user.workosUserId,
    returnTo,
  });
  const { codeVerifier, codeChallenge } = createXAccountPkce();
  await setXAccountPkceCookie(codeVerifier);

  return NextResponse.redirect(buildXAccountAuthorizationUrl(state, codeChallenge));
}
