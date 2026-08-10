import { describe, expect, it } from "vitest";
import {
  GOAT_ONBOARDING_CONNECTION_RETURN_TO,
  goatIntegrationConnectionSuccess,
  goatOnboardingConnectHref,
  goatOnboardingConnectionError,
} from "./onboarding-integrations";

describe("Goat onboarding integrations", () => {
  it("replaces an integration's settings return path with the popup completion route", () => {
    const href = goatOnboardingConnectHref(
      "/api/integrations/github/start?returnTo=/settings/integrations",
    );

    expect(new URL(href, "https://goat.test").searchParams.get("returnTo")).toBe(
      GOAT_ONBOARDING_CONNECTION_RETURN_TO,
    );
  });

  it("turns provider failures into actionable onboarding copy", () => {
    expect(goatOnboardingConnectionError("github", "admin_required")).toBe(
      "Only a workspace admin can connect GitHub.",
    );
    expect(goatOnboardingConnectionError("slack", "slack_denied")).toBe(
      "Slack authorization was cancelled.",
    );
    expect(goatOnboardingConnectionError("gmail", "gmail_denied")).toBe(
      "Gmail authorization was cancelled.",
    );
    expect(goatOnboardingConnectionError("linear", "not_configured")).toBe(
      "Linear isn't available right now. Please try again later.",
    );
    expect(goatOnboardingConnectionError("linear", "session_mismatch")).toContain(
      "Sign in with the same account",
    );
    expect(goatOnboardingConnectionError("posthog", "posthog_denied")).toBe(
      "PostHog authorization was cancelled.",
    );
    expect(goatOnboardingConnectionError("neon", "neon_denied")).toBe(
      "Neon authorization was cancelled.",
    );
    expect(goatOnboardingConnectionError("github", "missing_code")).toContain(
      "did not return a valid authorization",
    );
    expect(goatOnboardingConnectionError("github", "invalid_state")).toContain(
      "did not return a valid authorization",
    );
    expect(goatOnboardingConnectionError(null, "something_new")).toBe(
      "This source could not be connected. Please try again.",
    );
  });

  it("turns provider success into concise connection copy", () => {
    expect(goatIntegrationConnectionSuccess("hubspot")).toBe("HubSpot connected.");
    expect(goatIntegrationConnectionSuccess("google_drive")).toBe("Google Drive connected.");
    expect(goatIntegrationConnectionSuccess("posthog")).toBe("PostHog connected.");
    expect(goatIntegrationConnectionSuccess("neon")).toBe("Neon connected.");
    expect(goatIntegrationConnectionSuccess(null)).toBe("Integration connected.");
  });
});
