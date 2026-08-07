import { getAppUrl } from "@opencompany/core/app-url";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendLinearIngestStatus,
  buildLinearAuthorizationUrl,
  createLinearIngestState,
  isLinearIngestConfigured,
} from "@/lib/integrations/linear-ingest";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const appUrl = getAppUrl();
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isLinearIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendLinearIngestStatus(returnTo, "error", "not_configured"), appUrl),
    );
  }

  const state = createLinearIngestState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildLinearAuthorizationUrl(state));
}
