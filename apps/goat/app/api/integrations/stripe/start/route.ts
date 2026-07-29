import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatStripeIntegrationStatus,
  buildGoatStripeOAuthAuthorizationUrl,
  createGoatStripeOAuthState,
  goatStripeOAuthRedirectUri,
  isGoatStripeOAuthConfigured,
} from "@/lib/integrations/stripe";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/integrations";

  if (current.role !== "admin") {
    return NextResponse.redirect(
      new URL(appendGoatStripeIntegrationStatus(returnTo, "error", "admin_required"), url),
    );
  }
  if (!isGoatStripeOAuthConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatStripeIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const redirectUri = goatStripeOAuthRedirectUri();
  const state = createGoatStripeOAuthState({
    userWorkosId: current.user.workosUserId,
    workspaceId: current.workspace.id,
    returnTo,
    redirectUri,
  });
  return NextResponse.redirect(buildGoatStripeOAuthAuthorizationUrl(state, redirectUri));
}
