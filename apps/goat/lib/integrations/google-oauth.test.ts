import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoatGoogleAuthorizationUrl,
  createGoatGoogleIntegrationState,
  GOAT_GOOGLE_PROVIDER_CONFIG,
  verifyGoatGoogleIntegrationState,
} from "./google-oauth";

describe("Goat Google OAuth", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_INTEGRATION_STATE_SECRET", "state-secret");
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips signed state for the Goat user", () => {
    const state = createGoatGoogleIntegrationState({
      provider: "gmail",
      userWorkosId: "user_123",
      returnTo: "/settings",
    });

    expect(verifyGoatGoogleIntegrationState(state)).toMatchObject({
      provider: "gmail",
      userWorkosId: "user_123",
      returnTo: "/settings",
    });
  });

  it("requests independent read-only Gmail, Calendar, and Drive scopes", () => {
    const gmailUrl = new URL(
      buildGoatGoogleAuthorizationUrl(GOAT_GOOGLE_PROVIDER_CONFIG.gmail, "state"),
    );
    const calendarUrl = new URL(
      buildGoatGoogleAuthorizationUrl(GOAT_GOOGLE_PROVIDER_CONFIG.google_calendar, "state"),
    );
    const driveUrl = new URL(
      buildGoatGoogleAuthorizationUrl(GOAT_GOOGLE_PROVIDER_CONFIG.google_drive, "state"),
    );

    expect(gmailUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(calendarUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    expect(calendarUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.events.readonly",
    );
    expect(gmailUrl.searchParams.get("scope")).not.toContain("gmail.send");
    expect(calendarUrl.searchParams.get("scope")).not.toContain("calendar.events ");
    expect(driveUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.readonly",
    );
    expect(driveUrl.searchParams.get("scope")).not.toContain("gmail.readonly");
    expect(driveUrl.searchParams.get("scope")).not.toContain("calendar.readonly");
  });
});
