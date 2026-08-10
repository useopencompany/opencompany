import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatSlackIntegrationStatus,
  buildGoatSlackAuthorizationUrl,
  createGoatSlackIntegrationState,
  isGoatSlackIntegrationConfigured,
} from "@/lib/integrations/slack";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatSlackIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatSlackIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatSlackIntegrationState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildGoatSlackAuthorizationUrl(state));
}
