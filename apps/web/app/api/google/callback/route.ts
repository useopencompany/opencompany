import { captureException, createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/billing/stripe";
import {
  appendGoogleIntegrationStatus,
  GOOGLE_PROVIDER_CONFIG,
  googleDirectCallbackUrl,
  isAllowedGoogleOAuthTargetOrigin,
  verifyGoogleIntegrationState,
} from "@/lib/integrations/google-oauth";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

const FORWARDED_GOOGLE_OAUTH_PARAMS = [
  "code",
  "state",
  "scope",
  "error",
  "error_description",
  "error_uri",
  "authuser",
  "prompt",
  "hd",
] as const;

export async function GET(request: Request) {
  const url = new URL(request.url);

  let state;
  try {
    state = verifyGoogleIntegrationState(url.searchParams.get("state") ?? "");
  } catch (error) {
    captureException(error, {
      event: "opencompany.google_oauth_broker_callback_failed",
      reason: "invalid_state",
    });
    return NextResponse.redirect(new URL("/company/integrations?setup=error", getAppUrl()));
  }

  const config = GOOGLE_PROVIDER_CONFIG[state.provider];
  const targetOrigin = state.targetOrigin ?? new URL(getAppUrl()).origin;

  if (!isAllowedGoogleOAuthTargetOrigin(targetOrigin)) {
    logger.warn("Google OAuth broker rejected target origin", {
      event: "opencompany.google_oauth_broker_callback_failed",
      reason: "invalid_target_origin",
      provider: state.provider,
    });
    return NextResponse.redirect(
      new URL(appendGoogleIntegrationStatus(state.returnTo, state.provider, "error"), getAppUrl()),
    );
  }

  const redirect = new URL(googleDirectCallbackUrl(config, targetOrigin));
  for (const param of FORWARDED_GOOGLE_OAUTH_PARAMS) {
    const value = url.searchParams.get(param);
    if (value !== null) redirect.searchParams.set(param, value);
  }

  return NextResponse.redirect(redirect);
}
