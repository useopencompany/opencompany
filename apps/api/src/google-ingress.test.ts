import { createHash } from "node:crypto";
import {
  createGoogleIntegrationState,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
} from "@opencompany/agent/integrations/google-oauth";
import {
  loadGoogleDriveWatchChannel,
  requestGoogleDriveCursorWake,
} from "@opencompany/db/google-drive";
import { connectGoogleIntegration } from "@opencompany/db/integrations";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createGoogleIngress } from "./google-ingress";

vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectGoogleIntegration: vi.fn(),
}));
vi.mock("@opencompany/db/google-drive", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadGoogleDriveWatchChannel: vi.fn(),
  requestGoogleDriveCursorWake: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/google-oauth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeGoogleCode: vi.fn(),
  fetchGoogleUserInfo: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };
const refreshPluginRegistrations = vi.fn(async () => undefined);

function ingress(overrides: { noWorkspaces?: boolean; authError?: ApiError } = {}) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue(
    overrides.noWorkspaces
      ? []
      : ([
          { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "admin" },
        ] as never),
  );
  return createGoogleIngress({
    db: sentinelDb,
    refreshPluginRegistrations,
    identify: async () => {
      if (overrides.authError) throw overrides.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        credentialKind: "browser_cookie",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
  });
}

describe("Google ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-secret");
    vi.stubEnv("GOOGLE_INTEGRATION_STATE_SECRET", "google-state-secret-google-state-secret");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(44));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("redirects an authenticated user to the Google consent screen with signed state", async () => {
    const response = await ingress().start(
      "gmail",
      new Request("https://api.example.com/integrations/gmail/start?returnTo=/settings"),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("google-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://opencompany.example.com/api/integrations/gmail/callback",
    );
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("redirects anonymous browsers to the web sign-in", async () => {
    const response = await ingress({
      authError: new ApiError(401, "authentication_required", "Authentication required."),
    }).start(
      "google_drive",
      new Request("https://api.example.com/integrations/google-drive/start"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
  });

  it("rejects a state minted for another provider or user", async () => {
    const state = createGoogleIntegrationState({
      provider: "gmail",
      userWorkosId: "user_1",
      returnTo: "/settings",
    });
    const response = await ingress().callback(
      "google_calendar",
      new Request(
        `https://api.example.com/integrations/google-calendar/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("setup")).toBe("error");
    expect(connectGoogleIntegration).not.toHaveBeenCalled();
  });

  it("maps GitHub-style denial and a missing code to error redirects on the state returnTo", async () => {
    const state = createGoogleIntegrationState({
      provider: "gmail",
      userWorkosId: "user_1",
      returnTo: "/onboarding/connected",
    });
    const denied = await ingress().callback(
      "gmail",
      new Request(
        `https://api.example.com/integrations/gmail/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      ),
    );
    const deniedLocation = new URL(denied.headers.get("location") ?? "");
    expect(deniedLocation.pathname).toBe("/onboarding/connected");
    expect(deniedLocation.searchParams.get("setup")).toBe("error");

    const missingCode = await ingress().callback(
      "gmail",
      new Request(
        `https://api.example.com/integrations/gmail/callback?state=${encodeURIComponent(state)}`,
      ),
    );
    const missingLocation = new URL(missingCode.headers.get("location") ?? "");
    expect(missingLocation.pathname).toBe("/onboarding/connected");
    expect(missingLocation.searchParams.get("setup")).toBe("error");
    expect(connectGoogleIntegration).not.toHaveBeenCalled();
  });

  it("connects the account through the injected database and reports connected", async () => {
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      tokens: {
        access_token: "at",
        refresh_token: "rt",
        scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "ada@example.com",
      name: "Ada",
    } as never);
    vi.mocked(connectGoogleIntegration).mockResolvedValue(undefined as never);

    const state = createGoogleIntegrationState({
      provider: "gmail",
      userWorkosId: "user_1",
      returnTo: "/settings",
    });
    const response = await ingress().callback(
      "gmail",
      new Request(
        `https://api.example.com/integrations/gmail/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://opencompany.example.com");
    expect(location.searchParams.get("setup")).toBe("connected");
    expect(connectGoogleIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gmail",
        userWorkosId: "user_1",
        externalId: "google-sub-1",
        db: expect.objectContaining({ sentinel: "db" }),
      }),
    );
    expect(refreshPluginRegistrations).not.toHaveBeenCalled();
  });

  it("refreshes installed plugin discovery after Google Calendar connects", async () => {
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      tokens: {
        access_token: "at",
        refresh_token: "rt",
        scope: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ].join(" "),
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "ada@example.com",
      name: "Ada",
    } as never);
    vi.mocked(connectGoogleIntegration).mockResolvedValue(undefined as never);
    const state = createGoogleIntegrationState({
      provider: "google_calendar",
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/google-calendar",
    });

    const response = await ingress().callback(
      "google_calendar",
      new Request(
        `https://api.example.com/integrations/google-calendar/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );

    expect(response.status).toBe(302);
    expect(refreshPluginRegistrations).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceIds: ["workspace_1"],
    });
  });

  describe("drive webhook", () => {
    function driveNotification(state = "change") {
      return new Request("https://api.example.com/webhooks/google-drive", {
        method: "POST",
        headers: {
          "x-goog-channel-id": "channel_1",
          "x-goog-channel-token": "secret-token",
          "x-goog-resource-id": "resource_1",
          "x-goog-resource-state": state,
        },
      });
    }

    it("turns an authenticated notification into an idempotent cursor wake", async () => {
      vi.mocked(loadGoogleDriveWatchChannel).mockResolvedValue({
        id: "channel_1",
        cursorId: "cursor_1",
        tokenHash: sha256("secret-token"),
        resourceId: "resource_1",
        status: "active",
        expiresAt: new Date(Date.now() + 60_000),
      } as never);

      const response = await ingress().driveWebhook(driveNotification());
      expect(response.status).toBe(204);
      expect(requestGoogleDriveCursorWake).toHaveBeenCalledWith(
        "cursor_1",
        expect.any(Date),
        expect.objectContaining({ sentinel: "db" }),
      );
      expect(loadGoogleDriveWatchChannel).toHaveBeenCalledWith(
        "channel_1",
        expect.objectContaining({ sentinel: "db" }),
      );
    });

    it("rejects an invalid channel token without waking", async () => {
      vi.mocked(loadGoogleDriveWatchChannel).mockResolvedValue({
        id: "channel_1",
        cursorId: "cursor_1",
        tokenHash: sha256("different-token"),
        resourceId: "resource_1",
        status: "active",
        expiresAt: new Date(Date.now() + 60_000),
      } as never);

      const response = await ingress().driveWebhook(driveNotification());
      expect(response.status).toBe(401);
      expect(requestGoogleDriveCursorWake).not.toHaveBeenCalled();
    });

    it("accepts the early sync notification for a creating channel", async () => {
      vi.mocked(loadGoogleDriveWatchChannel).mockResolvedValue({
        id: "channel_1",
        cursorId: "cursor_1",
        tokenHash: sha256("secret-token"),
        resourceId: null,
        status: "creating",
        expiresAt: new Date(Date.now() + 60_000),
      } as never);

      const response = await ingress().driveWebhook(driveNotification("sync"));
      expect(response.status).toBe(204);
      expect(requestGoogleDriveCursorWake).toHaveBeenCalled();
    });

    it("rejects notifications with missing headers", async () => {
      const response = await ingress().driveWebhook(
        new Request("https://api.example.com/webhooks/google-drive", { method: "POST" }),
      );
      expect(response.status).toBe(400);
    });
  });
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
