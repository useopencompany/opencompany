import { connectHubspotIntegration } from "@opencompany/db/integrations";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendHubspotIngestStatus,
  exchangeHubspotCode,
  fetchHubspotIdentity,
  isHubspotIngestConfigured,
  verifyHubspotIngestState,
} from "@/lib/integrations/hubspot-ingest";

export async function GET(request: Request) {
  const current = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyHubspotIngestState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=hubspot&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== current.user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (!isHubspotIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(state.returnTo, "error", "not_configured"), url),
    );
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(state.returnTo, "error", "hubspot_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    const oauth = await exchangeHubspotCode(code);
    const identity = await fetchHubspotIdentity(oauth.accessToken);

    await connectHubspotIntegration({
      userWorkosId: current.user.workosUserId,
      portalId: identity.portalId,
      hubDomain: identity.hubDomain,
      userEmail: identity.userEmail,
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: identity.scopes,
    });

    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(state.returnTo, "error", "connection_sync_failed"), url),
    );
  }
}
