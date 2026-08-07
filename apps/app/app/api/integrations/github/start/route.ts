import {
  appendGitHubIntegrationStatus,
  buildGitHubInstallUrl,
  createGitHubIntegrationState,
  isGitHubIntegrationConfigured,
} from "@opencompany/core/integrations/github";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export async function GET(request: Request) {
  const { user, workspace, role } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  // GitHub App installations are workspace-owned plumbing; only admins may
  // connect them.
  if (role !== "admin") {
    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(returnTo, "error", "admin_required"), url),
    );
  }

  if (!isGitHubIntegrationConfigured()) {
    return NextResponse.redirect(
      new URL(appendGitHubIntegrationStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGitHubIntegrationState({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    returnTo,
  });

  return NextResponse.redirect(buildGitHubInstallUrl(state));
}
