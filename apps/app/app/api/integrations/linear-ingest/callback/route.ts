import { connectGoatLinearIngestIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { getGoatAppUrl } from "@/lib/app-url";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatLinearIngestStatus,
  exchangeGoatLinearCode,
  fetchGoatLinearIdentity,
  isGoatLinearIngestConfigured,
  verifyGoatLinearIngestState,
} from "@/lib/integrations/linear-ingest";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);
  const appUrl = getGoatAppUrl();
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGoatLinearIngestState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=linear&setup=error&reason=invalid_state", appUrl),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendGoatLinearIngestStatus(state.returnTo, "error", "session_mismatch"), appUrl),
    );
  }

  if (!isGoatLinearIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatLinearIngestStatus(state.returnTo, "error", "not_configured"), appUrl),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendGoatLinearIngestStatus(state.returnTo, "error", "linear_denied"), appUrl),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendGoatLinearIngestStatus(state.returnTo, "error", "missing_code"), appUrl),
    );
  }

  try {
    const oauth = await exchangeGoatLinearCode(code);
    const identity = await fetchGoatLinearIdentity(oauth.accessToken);

    await connectGoatLinearIngestIntegration({
      userWorkosId: current.user.workosUserId,
      organizationId: identity.organizationId,
      organizationName: identity.organizationName,
      organizationUrlKey: identity.organizationUrlKey,
      viewerId: identity.viewerId,
      viewerName: identity.viewerName,
      viewerEmail: identity.viewerEmail,
      accessToken: oauth.accessToken,
      scopes: oauth.scopes,
    });

    return NextResponse.redirect(
      new URL(appendGoatLinearIngestStatus(state.returnTo, "connected"), appUrl),
    );
  } catch {
    return NextResponse.redirect(
      new URL(
        appendGoatLinearIngestStatus(state.returnTo, "error", "connection_sync_failed"),
        appUrl,
      ),
    );
  }
}
