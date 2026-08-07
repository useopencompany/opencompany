import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { appendLatitudeMcpStatus, startLatitudeMcpOAuth } from "@/lib/integrations/latitude-mcp";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/settings";

  try {
    const result = await startLatitudeMcpOAuth({
      userWorkosId: user.workosUserId,
      returnTo,
    });
    if (result.status === "connected") {
      return NextResponse.redirect(new URL(appendLatitudeMcpStatus(returnTo, "connected"), url));
    }
    return NextResponse.redirect(result.redirectUrl);
  } catch {
    return NextResponse.redirect(
      new URL(appendLatitudeMcpStatus(returnTo, "error", "start_failed"), url),
    );
  }
}
