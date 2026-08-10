import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatGitHubIntegrationStatus,
  buildGoatGitHubInstallUrl,
  createGoatGitHubIntegrationState,
  isGoatGitHubIntegrationConfigured,
} from "@/lib/integrations/github";

export async function GET(request: Request) {
  const { user, workspace, role } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  // GitHub App installations are workspace-owned plumbing; only admins may
  // connect them.
  if (role !== "admin") {
    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(returnTo, "error", "admin_required"), url),
    );
  }

  if (!isGoatGitHubIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatGitHubIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatGitHubIntegrationState({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    returnTo,
  });

  return NextResponse.redirect(buildGoatGitHubInstallUrl(state));
}
