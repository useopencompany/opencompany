import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatHubspotIngestStatus,
  buildGoatHubspotAuthorizationUrl,
  createGoatHubspotIngestState,
  isGoatHubspotIngestConfigured,
} from "@/lib/integrations/hubspot-ingest";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatHubspotIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatHubspotIngestStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatHubspotIngestState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildGoatHubspotAuthorizationUrl(state));
}
