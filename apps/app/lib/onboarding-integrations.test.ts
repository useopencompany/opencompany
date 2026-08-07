import { describe, expect, it } from "vitest";
import {
  integrationConnectionSuccess,
  ONBOARDING_CONNECTION_RETURN_TO,
  onboardingConnectHref,
  onboardingConnectionError,
} from "./onboarding-integrations";

describe("Onboarding integrations", () => {
  it("replaces an integration's settings return path with the popup completion route", () => {
    const href = onboardingConnectHref(
      "/api/integrations/github/start?returnTo=/settings/integrations",
    );

    expect(new URL(href, "https://app.test").searchParams.get("returnTo")).toBe(
      ONBOARDING_CONNECTION_RETURN_TO,
    );
  });

  it("turns provider failures into actionable onboarding copy", () => {
    expect(onboardingConnectionError("github", "admin_required")).toBe(
      "Only a workspace admin can connect GitHub.",
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
    expect(onboardingConnectionError("posthog", "posthog_denied")).toBe(
      "PostHog authorization was cancelled.",
    );
    expect(onboardingConnectionError("neon", "neon_denied")).toBe(
      "Neon authorization was cancelled.",
    );
    expect(onboardingConnectionError("github", "missing_code")).toContain(
      "did not return a valid authorization",
    );
    expect(onboardingConnectionError("github", "invalid_state")).toContain(
      "did not return a valid authorization",
    );
    expect(onboardingConnectionError(null, "something_new")).toBe(
      "This source could not be connected. Please try again.",
    );
  });

  it("turns provider success into concise connection copy", () => {
    expect(integrationConnectionSuccess("hubspot")).toBe("HubSpot connected.");
    expect(integrationConnectionSuccess("google_drive")).toBe("Google Drive connected.");
    expect(integrationConnectionSuccess("posthog")).toBe("PostHog connected.");
    expect(integrationConnectionSuccess("neon")).toBe("Neon connected.");
    expect(integrationConnectionSuccess(null)).toBe("Integration connected.");
  });
});
