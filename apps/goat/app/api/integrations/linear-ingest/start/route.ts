import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatLinearIngestStatus,
  buildGoatLinearAuthorizationUrl,
  createGoatLinearIngestState,
  isGoatLinearIngestConfigured,
} from "@/lib/integrations/linear-ingest";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  if (!isGoatLinearIngestConfigured()) {
    return NextResponse.redirect(
      new URL(appendGoatLinearIngestStatus(returnTo, "error", "not_configured"), url),
    );
  }

  const state = createGoatLinearIngestState({
    userWorkosId: user.workosUserId,
    returnTo,
  });

  return NextResponse.redirect(buildGoatLinearAuthorizationUrl(state));
}
