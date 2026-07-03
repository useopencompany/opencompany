import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { appendGoatLinearMcpStatus, startGoatLinearMcpOAuth } from "@/lib/integrations/linear-mcp";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const result = await startGoatLinearMcpOAuth({
      userWorkosId: user.workosUserId,
      returnTo,
    });
    if (result.status === "connected") {
      return NextResponse.redirect(new URL(appendGoatLinearMcpStatus(returnTo, "connected"), url));
    }
    return NextResponse.redirect(result.redirectUrl);
  } catch {
    return NextResponse.redirect(
      new URL(appendGoatLinearMcpStatus(returnTo, "error", "start_failed"), url),
    );
  }
}
