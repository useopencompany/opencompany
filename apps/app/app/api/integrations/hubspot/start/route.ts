import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendHubspotIngestStatus,
  buildHubspotAuthorizationUrl,
  createHubspotIngestState,
  isHubspotIngestConfigured,
} from "@/lib/integrations/hubspot-ingest";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isHubspotIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendHubspotIngestStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createHubspotIngestState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildHubspotAuthorizationUrl(state));
}
