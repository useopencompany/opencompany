import {
  appendPostHogMcpStatus,
  startPostHogMcpOAuth,
} from "@opencompany/core/integrations/posthog-mcp";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const result = await startPostHogMcpOAuth({
      userWorkosId: user.workosUserId,
      returnTo,
    });
    if (result.status === "connected") {
      return NextResponse.redirect(new URL(appendPostHogMcpStatus(returnTo, "connected"), url));
    }
    return NextResponse.redirect(result.redirectUrl);
  } catch {
    return NextResponse.redirect(
      new URL(appendPostHogMcpStatus(returnTo, "error", "start_failed"), url),
    );
  }
}
