export const ONBOARDING_CONNECTION_MESSAGE = "goat-onboarding-connection" as const;
export const ONBOARDING_CONNECTION_STORAGE_KEY = "goat-onboarding-connection-result";
export const ONBOARDING_CONNECTION_RETURN_TO = "/onboarding/connected";

export type OnboardingConnectionMessage = {
  type: typeof ONBOARDING_CONNECTION_MESSAGE;
  provider: string | null;
  status: string | null;
  reason: string | null;
};

export type OnboardingConnectionResult = Omit<OnboardingConnectionMessage, "type">;

export function onboardingConnectHref(connectHref: string) {
  const url = new URL(connectHref, "https://goat.local");
  url.searchParams.set("returnTo", ONBOARDING_CONNECTION_RETURN_TO);
  return `${url.pathname}${url.search}`;
}

export function integrationConnectionError(provider: string | null, reason: string | null) {
  const name = providerName(provider);
  switch (reason) {
    case "admin_required":
      return `Only a workspace admin can connect ${name}.`;
    case "not_configured":
      return `${name} isn't available right now. Please try again later.`;
    case "session_mismatch":
      return `Sign in with the same account that started the ${name} connection, then try again.`;
    case "github_user_denied":
    case "gmail_denied":
    case "slack_denied":
    case "linear_denied":
    case "granola_denied":
    case "hubspot_denied":
    case "hubspot_mcp_denied":
    case "attio_mcp_denied":
    case "latitude_denied":
    case "posthog_denied":
    case "neon_denied":
    case "betterstack_denied":
    case "fathom_denied":
    case "signoz_denied":
    case "x_account_denied":
      return `${name} authorization was cancelled.`;
    case "missing_code":
    case "missing_installation_id":
    case "invalid_installation_action":
    case "invalid_state":
      return `${name} did not return a valid authorization. Please try again.`;
    case "installation_not_authorized":
      return `The selected GitHub App installation is not available to this GitHub account.`;
    case "connection_sync_failed":
      return `${name} authorized successfully, but setup could not be completed. Please try again.`;
    default:
      return `${name} could not be connected. Please try again.`;
  }
}

export const onboardingConnectionError = integrationConnectionError;

export function integrationConnectionSuccess(provider: string | null) {
  const name = providerName(provider);
  return name === "This source" ? "Integration connected." : `${name} connected.`;
}

function providerName(provider: string | null) {
  switch (provider) {
    case "github_user":
      return "GitHub";
    case "gmail":
      return "Gmail";
    case "google_calendar":
      return "Google Calendar";
    case "google_drive":
      return "Google Drive";
    case "linear":
      return "Linear";
    case "slack":
      return "Slack";
    case "jamie":
      return "Jamie";
    case "hubspot":
      return "HubSpot";
    case "granola":
      return "Granola";
    case "fathom":
      return "Fathom";
    case "attio":
      return "Attio";
    case "stripe":
      return "Stripe";
    case "latitude":
      return "Latitude";
    case "posthog":
      return "PostHog";
    case "neon":
      return "Neon";
    case "betterstack":
      return "Better Stack";
    case "render":
      return "Render";
    case "signoz":
      return "SigNoz";
    case "x_account":
      return "X";
    default:
      return "This source";
  }
}
