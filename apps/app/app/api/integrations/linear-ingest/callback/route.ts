import { getAppUrl } from "@opencompany/core/app-url";
import { connectLinearIngestIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendLinearIngestStatus,
  exchangeLinearCode,
  fetchLinearIdentity,
  isLinearIngestConfigured,
  verifyLinearIngestState,
} from "@/lib/integrations/linear-ingest";

export async function GET(request: Request) {
  const current = await currentUser();
  const url = new URL(request.url);
  const appUrl = getAppUrl();
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyLinearIngestState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=linear&setup=error&reason=invalid_state", appUrl),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendLinearIngestStatus(state.returnTo, "error", "session_mismatch"), appUrl),
    );
  }

  if (!isLinearIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendLinearIngestStatus(state.returnTo, "error", "not_configured"), appUrl),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendLinearIngestStatus(state.returnTo, "error", "linear_denied"), appUrl),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendLinearIngestStatus(state.returnTo, "error", "missing_code"), appUrl),
    );
  }

  try {
    const oauth = await exchangeLinearCode(code);
    const identity = await fetchLinearIdentity(oauth.accessToken);

    await connectLinearIngestIntegration({
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
      new URL(appendLinearIngestStatus(state.returnTo, "connected"), appUrl),
    );
  } catch {
    return NextResponse.redirect(
      new URL(appendLinearIngestStatus(state.returnTo, "error", "connection_sync_failed"), appUrl),
    );
  }
}
