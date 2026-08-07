import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendSlackBotSetupStatus,
  buildSlackBotAuthorizationUrl,
  createSlackBotState,
  isSlackBotConfigured,
} from "@/lib/integrations/slack-bot";

export async function GET(request: Request) {
  const context = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/workspace/slack";

  if (context.role !== "admin") {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(returnTo, "error", "admin_required"), url),
    );
  }

  if (!isSlackBotConfigured()) {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createSlackBotState({
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
    returnTo,
  });

  return NextResponse.redirect(buildSlackBotAuthorizationUrl(state));
}
