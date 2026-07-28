import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatLatitudeMcpStatus,
  startGoatLatitudeMcpOAuth,
} from "@/lib/integrations/latitude-mcp";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const result = await startGoatLatitudeMcpOAuth({
      userWorkosId: user.workosUserId,
      returnTo,
    });
    if (result.status === "connected") {
      return NextResponse.redirect(
        new URL(appendGoatLatitudeMcpStatus(returnTo, "connected"), url),
      );
    }
    return NextResponse.redirect(result.redirectUrl);
  } catch {
    return NextResponse.redirect(
      new URL(appendGoatLatitudeMcpStatus(returnTo, "error", "start_failed"), url),
    );
  }
}
