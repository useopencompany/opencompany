import { describe, expect, it } from "vitest";
import {
  integrationConnectionSuccess,
  ONBOARDING_CONNECTION_RETURN_TO,
  onboardingConnectHref,
  onboardingConnectionError,
} from "./onboarding-integrations";

describe("opencompany onboarding integrations", () => {
  it("replaces an integration's settings return path with the popup completion route", () => {
    const href = onboardingConnectHref(
      "/api/integrations/github-user/start?returnTo=/settings/plugins/github",
    );

    expect(new URL(href, "https://opencompany.test").searchParams.get("returnTo")).toBe(
      ONBOARDING_CONNECTION_RETURN_TO,
    );
  });

  it("turns provider failures into actionable onboarding copy", () => {
    expect(onboardingConnectionError("slack", "admin_required")).toBe(
      "Only a workspace admin can connect Slack.",
    );
    expect(onboardingConnectionError("slack", "slack_denied")).toBe(
      "Slack authorization was cancelled.",
    );
    expect(onboardingConnectionError("gmail", "gmail_denied")).toBe(
      "Gmail authorization was cancelled.",
    );
    expect(onboardingConnectionError("linear", "not_configured")).toBe(
      "Linear isn't available right now. Please try again later.",
    );
    expect(onboardingConnectionError("linear", "session_mismatch")).toContain(
      "Sign in with the same account",
    );
    expect(onboardingConnectionError("vercel", "provider_approval_required")).toBe(
      "Vercel requires provider approval before it can connect. It isn't available yet.",
    );
    expect(onboardingConnectionError("posthog", "posthog_denied")).toBe(
      "PostHog authorization was cancelled.",
    );
    expect(onboardingConnectionError("hubspot", "hubspot_mcp_denied")).toBe(
      "HubSpot authorization was cancelled.",
    );
    expect(onboardingConnectionError("attio", "attio_mcp_denied")).toBe(
      "Attio authorization was cancelled.",
    );
    expect(onboardingConnectionError("neon", "neon_denied")).toBe(
      "Neon authorization was cancelled.",
    );
    expect(onboardingConnectionError("betterstack", "betterstack_denied")).toBe(
      "Better Stack authorization was cancelled.",
    );
    expect(onboardingConnectionError("signoz", "signoz_denied")).toBe(
      "SigNoz authorization was cancelled.",
    );
    expect(onboardingConnectionError("fathom", "fathom_denied")).toBe(
      "Fathom authorization was cancelled.",
    );
    expect(onboardingConnectionError("vercel", "vercel_denied")).toBe(
      "Vercel authorization was cancelled.",
    );
    expect(onboardingConnectionError("github_user", "missing_code")).toContain(
      "did not return a valid authorization",
    );
    expect(onboardingConnectionError("github_user", "invalid_state")).toContain(
      "did not return a valid authorization",
    );
    expect(onboardingConnectionError("github_user", "github_user_denied")).toBe(
      "GitHub authorization was cancelled.",
    );
    expect(onboardingConnectionError("github_user", "connection_sync_failed")).toBe(
      "GitHub authorized successfully, but setup could not be completed. Please try again.",
    );
    expect(onboardingConnectionError("github_user", "installation_not_authorized")).toBe(
      "The selected GitHub App installation is not available to this GitHub account.",
    );
    expect(onboardingConnectionError(null, "something_new")).toBe(
      "This source could not be connected. Please try again.",
    );
  });

  it("turns provider success into concise connection copy", () => {
    expect(integrationConnectionSuccess("hubspot")).toBe("HubSpot connected.");
    expect(integrationConnectionSuccess("attio")).toBe("Attio connected.");
    expect(integrationConnectionSuccess("google_drive")).toBe("Google Drive connected.");
    expect(integrationConnectionSuccess("posthog")).toBe("PostHog connected.");
    expect(integrationConnectionSuccess("neon")).toBe("Neon connected.");
    expect(integrationConnectionSuccess("betterstack")).toBe("Better Stack connected.");
    expect(integrationConnectionSuccess("signoz")).toBe("SigNoz connected.");
    expect(integrationConnectionSuccess("vercel")).toBe("Vercel connected.");
    expect(integrationConnectionSuccess("github_user")).toBe("GitHub connected.");
    expect(integrationConnectionSuccess(null)).toBe("Integration connected.");
  });
});
