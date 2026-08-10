import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatPostHogMcpStatus,
  startGoatPostHogMcpOAuth,
} from "@/lib/integrations/posthog-mcp";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const result = await startGoatPostHogMcpOAuth({
      userWorkosId: user.workosUserId,
      returnTo,
    });
    if (result.status === "connected") {
      return NextResponse.redirect(new URL(appendGoatPostHogMcpStatus(returnTo, "connected"), url));
    }
    return NextResponse.redirect(result.redirectUrl);
  } catch {
    return NextResponse.redirect(
      new URL(appendGoatPostHogMcpStatus(returnTo, "error", "start_failed"), url),
    );
  }
}
