import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatLatitudeMcpStatus,
  completeGoatLatitudeMcpOAuth,
  verifyGoatLatitudeMcpState,
} from "@/lib/integrations/latitude-mcp";

export async function GET(request: Request) {
  const { user } = await currentGoatUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyGoatLatitudeMcpState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?integration=latitude&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendGoatLatitudeMcpStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (url.searchParams.get("error")) {
    return NextResponse.redirect(
      new URL(appendGoatLatitudeMcpStatus(state.returnTo, "error", "latitude_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendGoatLatitudeMcpStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    await completeGoatLatitudeMcpOAuth({
      userWorkosId: user.workosUserId,
      integrationId: state.integrationId,
      code,
      state: stateValue,
    });
    return NextResponse.redirect(
      new URL(appendGoatLatitudeMcpStatus(state.returnTo, "connected"), url),
    );
  } catch {
    return NextResponse.redirect(
      new URL(appendGoatLatitudeMcpStatus(state.returnTo, "error", "token_exchange_failed"), url),
    );
  }
}
