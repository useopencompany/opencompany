import {
  appendSlackIntegrationStatus,
  buildSlackAuthorizationUrl,
  createSlackIntegrationState,
  isSlackIntegrationConfigured,
} from "@opencompany/core/integrations/slack";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isSlackIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendSlackIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createSlackIntegrationState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildSlackAuthorizationUrl(state));
}
