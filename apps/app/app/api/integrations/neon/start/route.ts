import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { appendNeonMcpStatus, startNeonMcpOAuth } from "@/lib/integrations/neon-mcp";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const result = await startNeonMcpOAuth({
      userWorkosId: user.workosUserId,
      returnTo,
    });
    if (result.status === "connected") {
      return NextResponse.redirect(new URL(appendNeonMcpStatus(returnTo, "connected"), url));
    }
    return NextResponse.redirect(result.redirectUrl);
  } catch {
    return NextResponse.redirect(
      new URL(appendNeonMcpStatus(returnTo, "error", "start_failed"), url),
    );
  }
}
