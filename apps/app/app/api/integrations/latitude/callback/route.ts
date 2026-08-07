import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendLatitudeMcpStatus,
  completeLatitudeMcpOAuth,
  verifyLatitudeMcpState,
} from "@/lib/integrations/latitude-mcp";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyLatitudeMcpState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?integration=latitude&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendLatitudeMcpStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (url.searchParams.get("error")) {
    return NextResponse.redirect(
      new URL(appendLatitudeMcpStatus(state.returnTo, "error", "latitude_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendLatitudeMcpStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    await completeLatitudeMcpOAuth({
      userWorkosId: user.workosUserId,
      integrationId: state.integrationId,
      code,
      state: stateValue,
    });
    return NextResponse.redirect(
      new URL(appendLatitudeMcpStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(appendLatitudeMcpStatus(state.returnTo, "error", "token_exchange_failed"), url),
    );
  }
}
