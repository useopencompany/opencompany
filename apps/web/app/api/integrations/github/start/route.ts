import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";
import {
  appendIntegrationStatus,
  buildGitHubInstallUrl,
  createGitHubIntegrationState,
  isGitHubWorkIntegrationConfigured,
} from "@/lib/integrations/github";

export async function GET(request: Request) {
  // skipOnboarding: the onboarding integrations step opens this OAuth flow in a popup before
  // onboarding is marked complete; the default gate would bounce the popup to /onboarding.
  const { user, workspace } = await currentWorkspace({ requireAdmin: true, skipOnboarding: true });
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
