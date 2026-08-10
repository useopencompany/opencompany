import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoatGoogleAuthorizationUrl,
  createGoatGoogleIntegrationState,
  GOAT_GOOGLE_PROVIDER_CONFIG,
  goatGoogleOAuthRedirectUri,
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

  it("requests draft-capable Gmail, writable Calendar, and read-plus-edit Drive scopes", () => {
    const gmailUrl = new URL(
      buildGoatGoogleAuthorizationUrl(GOAT_GOOGLE_PROVIDER_CONFIG.gmail, "state"),
    );
    const calendarUrl = new URL(
      buildGoatGoogleAuthorizationUrl(GOAT_GOOGLE_PROVIDER_CONFIG.google_calendar, "state"),
    );
    const driveUrl = new URL(
      buildGoatGoogleAuthorizationUrl(GOAT_GOOGLE_PROVIDER_CONFIG.google_drive, "state"),
    );

    const gmailScopes = gmailUrl.searchParams.get("scope")?.split(" ") ?? [];
    expect(gmailScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(calendarUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    expect(calendarUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.events",
    );
    expect(gmailScopes).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(gmailScopes).not.toContain("https://www.googleapis.com/auth/gmail.send");
    expect(calendarUrl.searchParams.get("scope")).not.toContain("calendar.events.readonly");
    expect(driveUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.readonly",
    );
    expect(driveUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/documents",
    );
    expect(driveUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/spreadsheets",
    );
    expect(driveUrl.searchParams.get("scope")).not.toContain("gmail.readonly");
    expect(driveUrl.searchParams.get("scope")).not.toContain("calendar.readonly");
  });

  it("uses direct Goat callbacks", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://opencompany.chat");

    expect(
      Object.values(GOAT_GOOGLE_PROVIDER_CONFIG).map((config) =>
        goatGoogleOAuthRedirectUri(config),
      ),
    ).toEqual([
      "https://opencompany.chat/api/integrations/gmail/callback",
      "https://opencompany.chat/api/integrations/google-calendar/callback",
      "https://opencompany.chat/api/integrations/google-drive/callback",
    ]);
  });
});
