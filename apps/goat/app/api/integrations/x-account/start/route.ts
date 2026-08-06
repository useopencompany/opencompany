import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatXAccountIntegrationStatus,
  buildGoatXAccountAuthorizationUrl,
  createGoatXAccountIntegrationState,
  createGoatXAccountPkce,
  isGoatXAccountIntegrationConfigured,
} from "@/lib/integrations/x-account";
import { setGoatXAccountPkceCookie } from "@/lib/integrations/x-account-pkce";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatXAccountIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatXAccountIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatXAccountIntegrationState({
    userWorkosId: user.workosUserId,
    returnTo,
  });
  const { codeVerifier, codeChallenge } = createGoatXAccountPkce();
  await setGoatXAccountPkceCookie(codeVerifier);

  return NextResponse.redirect(buildGoatXAccountAuthorizationUrl(state, codeChallenge));
}
