import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleIntegrationState } from "@/lib/integrations/google-oauth";
import { GET } from "./route";

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

function state(targetOrigin?: string) {
  return createGoogleIntegrationState({
    provider: "gmail",
    workspaceId: "wks_123",
    userId: "usr_123",
    returnTo: "/company/integrations",
    ...(targetOrigin ? { targetOrigin } : {}),
  });
}

describe("Google OAuth broker callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_INTEGRATION_STATE_SECRET", "state-secret-with-enough-length");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.opencompany.cloud");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects valid preview targets to their in-app callback", async () => {
    const signedState = state("https://pr-42.preview.opencompany.cloud");
    const response = await GET(
      new Request(
        `https://oauth.opencompany.cloud/api/google/callback?code=auth-code&scope=email&state=${encodeURIComponent(signedState)}`,
      ),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(response.status).toBe(307);
    expect(location.origin).toBe("https://pr-42.preview.opencompany.cloud");
    expect(location.pathname).toBe("/api/integrations/gmail/callback");
    expect(location.searchParams.get("code")).toBe("auth-code");
    expect(location.searchParams.get("state")).toBe(signedState);
  });

  it("redirects states without target origin to the current app callback", async () => {
    const signedState = state();
    const response = await GET(
      new Request(
        `https://oauth.opencompany.cloud/api/google/callback?code=auth-code&state=${encodeURIComponent(signedState)}`,
      ),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://app.opencompany.cloud");
    expect(location.pathname).toBe("/api/integrations/gmail/callback");
  });

  it("rejects invalid target origins", async () => {
    const signedState = state("https://evil.example.com");
    const response = await GET(
      new Request(
        `https://oauth.opencompany.cloud/api/google/callback?code=auth-code&state=${encodeURIComponent(signedState)}`,
      ),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://app.opencompany.cloud");
    expect(location.pathname).toBe("/company/integrations");
    expect(location.searchParams.get("integration")).toBe("gmail");
    expect(location.searchParams.get("setup")).toBe("error");
  });

  it("forwards Google OAuth error params safely", async () => {
    const signedState = state("https://pr-42.preview.opencompany.cloud");
    const response = await GET(
      new Request(
        `https://oauth.opencompany.cloud/api/google/callback?error=access_denied&error_description=${encodeURIComponent("Denied by user")}&state=${encodeURIComponent(signedState)}&access_token=must-not-forward`,
      ),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://pr-42.preview.opencompany.cloud");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe("Denied by user");
    expect(location.searchParams.get("state")).toBe(signedState);
    expect(location.searchParams.has("access_token")).toBe(false);
  });
});
