import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatSlackBotSetupStatus,
  buildGoatSlackBotAuthorizationUrl,
  createGoatSlackBotState,
  isGoatSlackBotConfigured,
} from "@/lib/integrations/slack-bot";

export async function GET(request: Request) {
  const context = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings/workspace/slack";

  if (context.role !== "admin") {
    return NextResponse.redirect(
      new URL(appendGoatSlackBotSetupStatus(returnTo, "error", "admin_required"), url),
    );
  }

  if (!isGoatSlackBotConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatSlackBotSetupStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatSlackBotState({
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
    returnTo,
  });

  return NextResponse.redirect(buildGoatSlackBotAuthorizationUrl(state));
}
