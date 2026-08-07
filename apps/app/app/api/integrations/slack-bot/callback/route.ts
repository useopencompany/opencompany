import { connectSlackBotIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendSlackBotSetupStatus,
  exchangeSlackBotCode,
  isSlackBotConfigured,
  verifySlackBotState,
} from "@/lib/integrations/slack-bot";

export async function GET(request: Request) {
  const context = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifySlackBotState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL(
        "/settings/workspace/slack?integration=slack_bot&setup=error&reason=invalid_state",
        url,
      ),
    );
  }

  if (
    state.userWorkosId !== context.user.workosUserId ||
    state.workspaceId !== context.workspace.id ||
    context.role !== "admin"
  ) {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (!isSlackBotConfigured()) {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(state.returnTo, "error", "slack_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const oauth = await exchangeSlackBotCode(code);

    await connectSlackBotIntegration({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      teamId: oauth.teamId,
      teamName: oauth.teamName,
      botUserId: oauth.botUserId,
      accessToken: oauth.accessToken,
      scopes: oauth.scopes,
    });

    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(appendSlackBotSetupStatus(state.returnTo, "error", "connection_sync_failed"), url),
    );
  }
}
