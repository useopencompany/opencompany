import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatGitHubIntegrationStatus,
  buildGoatGitHubInstallUrl,
  createGoatGitHubIntegrationState,
  isGoatGitHubIntegrationConfigured,
} from "@/lib/integrations/github";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatGitHubIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatGitHubIntegrationState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildGoatGitHubInstallUrl(state));
}
