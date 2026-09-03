import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_DRIVE_MCP_ENDPOINT_URL,
  getGoogleDriveMcpIntegrationState,
  loadGoogleDriveMcpWorkerConnection,
} from "./google-drive-mcp";
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READ_SCOPE } from "./google-drive-scopes";

const connectedRow = {
  id: "gint_drive_latest",
  userWorkosId: "user_1",
  status: "connected" as const,
  scopes: [GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
  capabilityModes: { query: "ask" },
  toolModes: { create_file: "off" },
};

describe("Google Drive MCP connection", () => {
  it("exposes the official endpoint and the selected account's permission state", async () => {
    expect(GOOGLE_DRIVE_MCP_ENDPOINT_URL).toBe("https://drivemcp.googleapis.com/mcp/v1");
    await expect(
      getGoogleDriveMcpIntegrationState(
        { userWorkosId: "user_1" },
        { loadIntegration: vi.fn(async () => connectedRow) },
      ),
    ).resolves.toEqual({
      connected: true,
      integrationId: "gint_drive_latest",
      capabilityModes: { query: "ask" },
      toolModes: { create_file: "off" },
    });
  });

  it("injects only the latest account's short-lived access token", async () => {
    const getAccessToken = vi.fn(async () => "google-access-token");
    const connection = await loadGoogleDriveMcpWorkerConnection(
      {
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      },
      {
        loadIntegration: vi.fn(async () => connectedRow),
        getAccessToken,
      },
    );

    expect(connection).toMatchObject({ ok: true, integrationId: "gint_drive_latest" });
    if (!connection.ok) throw new Error("Expected a connected Google Drive account.");
    expect(await connection.authProvider.tokens()).toEqual({
      access_token: "google-access-token",
      token_type: "Bearer",
    });
    expect(getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_drive_latest",
      provider: "google_drive",
    });
  });

  it("fails closed until legacy Drive accounts grant the official MCP scopes", async () => {
    const legacyRow = { ...connectedRow, scopes: [GOOGLE_DRIVE_READ_SCOPE] };
    const loadIntegration = vi.fn(async () => legacyRow);
    const getAccessToken = vi.fn(async () => "unused");

    await expect(
      getGoogleDriveMcpIntegrationState("user_1", { loadIntegration }),
    ).resolves.toMatchObject({ connected: false, integrationId: "gint_drive_latest" });
    await expect(
      loadGoogleDriveMcpWorkerConnection(
        {
          userWorkosId: "user_1",
          onAuthorizationRequired: () => {
            throw new Error("authorization required");
          },
        },
        { loadIntegration, getAccessToken },
      ),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
