import { NextResponse } from "next/server";
import { getCurrentWorkspace } from "@/lib/auth";
import {
  appendIntegrationStatus,
  buildGitHubInstallUrl,
  createGitHubIntegrationState,
  isGitHubWorkIntegrationConfigured,
} from "@/lib/integrations/github";

export async function GET(request: Request) {
  const { user, workspace } = await getCurrentWorkspace();
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent") === "agent" ? "agent" : "settings";
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/integrations";
  if (!isGitHubWorkIntegrationConfigured()) {
    return NextResponse.redirect(new URL(appendIntegrationStatus(returnTo, "error"), url));
  }

  const state = createGitHubIntegrationState({
    workspaceId: workspace.id,
    userId: user.id,
    intent,
    returnTo,
  });

  return NextResponse.redirect(buildGitHubInstallUrl(state));
}
