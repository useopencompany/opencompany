import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIntegration: vi.fn(),
}));

vi.mock("./google-access-token", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGoogleAccessToken: mocks.getAccessToken,
}));
vi.mock("./google-data", () => ({
  loadGoogleCalendarIntegration: mocks.loadIntegration,
}));

import { GoogleAccessAuthError } from "./google-access-token";
import {
  GOOGLE_CALENDAR_MCP_ENDPOINT_URL,
  getGoogleCalendarMcpIntegrationState,
  loadGoogleCalendarMcpWorkerConnection,
} from "./google-calendar-mcp";
import { GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_CALENDAR_READ_SCOPE } from "./google-calendar-scopes";

const connectedRow = {
  id: "gint_google_calendar",
  userWorkosId: "user_1",
  status: "connected",
  accountEmail: "ada@example.com",
  accountName: "Ada",
  statusReason: null,
  scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
  capabilityModes: { query: "ask" },
  toolModes: { delete_event: "off" },
};

describe("Google Calendar MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.getAccessToken.mockResolvedValue("google-access-token");
  });

  it("exposes the official endpoint and the connection permission state", async () => {
    expect(GOOGLE_CALENDAR_MCP_ENDPOINT_URL).toBe("https://calendarmcp.googleapis.com/mcp/v1");
    await expect(getGoogleCalendarMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual(
      {
        connected: true,
        integrationId: "gint_google_calendar",
        capabilityModes: { query: "ask" },
        toolModes: { delete_event: "off" },
      },
    );
  });

  it("injects only the refreshed Google access token into the server-side bearer provider", async () => {
    const connection = await loadGoogleCalendarMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_google_calendar" });
    if (!connection.ok) throw new Error("Expected a connected Google Calendar account.");
    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_google_calendar",
      provider: "google_calendar",
    });
    expect(await connection.authProvider.tokens()).toEqual({
      access_token: "google-access-token",
      token_type: "Bearer",
    });
  });

  it("fails closed for missing credentials or legacy grants without plugin scopes", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(
      loadGoogleCalendarMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "not_connected" });

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: [GOOGLE_CALENDAR_READ_SCOPE],
    });
    await expect(
      loadGoogleCalendarMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.getAccessToken.mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    await expect(
      loadGoogleCalendarMcpWorkerConnection({
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("requests reauthorization only when a forced Google refresh also fails", async () => {
    const authorizationError = new Error("authorization required");
    mocks.getAccessToken
      .mockResolvedValueOnce("google-access-token")
      .mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    const connection = await loadGoogleCalendarMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected Google Calendar account.");

    await expect(
      connection.authProvider.validateResourceURL?.(
        GOOGLE_CALENDAR_MCP_ENDPOINT_URL,
        GOOGLE_CALENDAR_MCP_ENDPOINT_URL,
      ),
    ).rejects.toBe(authorizationError);
    expect(mocks.getAccessToken).toHaveBeenLastCalledWith(
      {
        userWorkosId: "user_1",
        integrationId: "gint_google_calendar",
        provider: "google_calendar",
      },
      { forceRefresh: true },
    );
  });
});
