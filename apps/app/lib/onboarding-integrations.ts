export const GOAT_ONBOARDING_CONNECTION_MESSAGE = "goat-onboarding-connection" as const;
export const GOAT_ONBOARDING_CONNECTION_STORAGE_KEY = "goat-onboarding-connection-result";
export const GOAT_ONBOARDING_CONNECTION_RETURN_TO = "/onboarding/connected";

export type GoatOnboardingConnectionMessage = {
  type: typeof GOAT_ONBOARDING_CONNECTION_MESSAGE;
  provider: string | null;
  status: string | null;
  reason: string | null;
};

export type GoatOnboardingConnectionResult = Omit<GoatOnboardingConnectionMessage, "type">;

export function goatOnboardingConnectHref(connectHref: string) {
  const url = new URL(connectHref, "https://goat.local");
  url.searchParams.set("returnTo", GOAT_ONBOARDING_CONNECTION_RETURN_TO);
  return `${url.pathname}${url.search}`;
}

export function goatIntegrationConnectionError(provider: string | null, reason: string | null) {
  const name = providerName(provider);
  switch (reason) {
    case "admin_required":
      return `Only a workspace admin can connect ${name}.`;
    case "not_configured":
      return `${name} isn't available right now. Please try again later.`;
    case "session_mismatch":
      return `Sign in with the same account that started the ${name} connection, then try again.`;
    case "github_denied":
    case "gmail_denied":
    case "slack_denied":
    case "linear_denied":
    case "hubspot_denied":
    case "latitude_denied":
    case "posthog_denied":
    case "neon_denied":
      return `${name} authorization was cancelled.`;
    case "missing_code":
    case "missing_installation_id":
    case "invalid_state":
      return `${name} did not return a valid authorization. Please try again.`;
    default:
      return `${name} could not be connected. Please try again.`;
  }
}

export const goatOnboardingConnectionError = goatIntegrationConnectionError;

export function goatIntegrationConnectionSuccess(provider: string | null) {
  const name = providerName(provider);
  return name === "This source" ? "Integration connected." : `${name} connected.`;
}

function providerName(provider: string | null) {
  switch (provider) {
    case "github":
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
    default:
      return "This source";
  }
}
