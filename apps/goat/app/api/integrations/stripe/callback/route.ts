import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import {
  appendGoatStripeIntegrationStatus,
  connectGoatStripeIntegration,
  exchangeGoatStripeOAuthCode,
  isGoatStripeOAuthConfigured,
  validateGoatStripeOAuthAccess,
  verifyGoatStripeOAuthState,
} from "@/lib/integrations/stripe";

export async function GET(request: Request) {
  const current = await currentGoatUser();
  const url = new URL(request.url);

  let state;
  try {
    state = verifyGoatStripeOAuthState(url.searchParams.get("state") ?? "");
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?integration=stripe&setup=error&reason=invalid_state", url),
    );
  }

  const errorRedirect = (reason: string) =>
    NextResponse.redirect(
      new URL(appendGoatStripeIntegrationStatus(state.returnTo, "error", reason), url),
    );

  if (
    current.role !== "admin" ||
    state.userWorkosId !== current.user.workosUserId ||
    state.workspaceId !== current.workspace.id
  ) {
    return errorRedirect(current.role === "admin" ? "session_mismatch" : "admin_required");
  }
  if (!isGoatStripeOAuthConfigured()) return errorRedirect("not_configured");
  if (url.searchParams.get("error")) return errorRedirect("stripe_denied");

  const code = url.searchParams.get("code");
  if (!code) return errorRedirect("missing_code");

  try {
    const tokens = await exchangeGoatStripeOAuthCode(code);
    const validation = await validateGoatStripeOAuthAccess(tokens);
    if (!validation.ok) {
      console.warn("[goat-stripe] OAuth grant failed validation.", {
        reason: validation.error,
        workspaceId: current.workspace.id,
      });
      return errorRedirect(
        validation.reason === "missing_permissions"
          ? "missing_permissions"
          : "connection_sync_failed",
      );
    }

    await connectGoatStripeIntegration({
      userWorkosId: current.user.workosUserId,
      workspaceId: current.workspace.id,
      tokens,
      identity: validation.identity,
    });
    return NextResponse.redirect(
      new URL(appendGoatStripeIntegrationStatus(state.returnTo, "connected"), url),
    );
  } catch (error) {
    console.warn("[goat-stripe] OAuth callback failed while connecting account.", {
      event: "goat.stripe_oauth_callback_failed",
      workspaceId: current.workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorRedirect("connection_sync_failed");
  }
}
