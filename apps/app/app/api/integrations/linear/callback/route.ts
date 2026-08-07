import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  appendLinearMcpStatus,
  completeLinearMcpOAuth,
  verifyLinearMcpState,
} from "@/lib/integrations/linear-mcp";

export async function GET(request: Request) {
  const { user } = await currentUser();
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";

  let state;
  try {
    state = verifyLinearMcpState(stateValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings?integration=linear&setup=error&reason=invalid_state", url),
    );
  }

  if (state.userWorkosId !== user.workosUserId) {
    return NextResponse.redirect(
      new URL(appendLinearMcpStatus(state.returnTo, "error", "session_mismatch"), url),
    );
  }

  if (url.searchParams.get("error")) {
    return NextResponse.redirect(
      new URL(appendLinearMcpStatus(state.returnTo, "error", "linear_denied"), url),
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL(appendLinearMcpStatus(state.returnTo, "error", "missing_code"), url),
    );
  }

  try {
    await completeLinearMcpOAuth({
      userWorkosId: user.workosUserId,
      integrationId: state.integrationId,
      code,
      state: stateValue,
    });
    return NextResponse.redirect(new URL(appendLinearMcpStatus(state.returnTo, "connected"), url));
  } catch {
    return NextResponse.redirect(
      new URL(appendLinearMcpStatus(state.returnTo, "error", "token_exchange_failed"), url),
    );
  }
}
