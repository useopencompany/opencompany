import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIntegration: vi.fn(),
}));

vi.mock("./google-access-token", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGoogleAccessToken: mocks.getAccessToken,
}));
vi.mock("./google-data", () => ({
  loadGoogleDriveIntegration: mocks.loadIntegration,
}));

import { GoogleAccessAuthError } from "./google-access-token";
import {
  GOOGLE_DRIVE_MCP_ENDPOINT_URL,
  getGoogleDriveMcpIntegrationState,
  googleDriveMcpRuntimeEndpointUrl,
  loadGoogleDriveMcpWorkerConnection,
} from "./google-drive-mcp";
import { verifyGoogleDriveMcpTicket } from "./google-drive-mcp-ticket";
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READ_SCOPE } from "./google-drive-scopes";

const connectedRow = {
  id: "gint_drive_latest",
  userWorkosId: "user_1",
  status: "connected",
  accountEmail: "ada@example.com",
  accountName: "Ada",
  statusReason: null,
  scopes: [GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
  capabilityModes: { query: "ask" },
  toolModes: { create_file: "off" },
};

const connectionInput = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  registrationId: "registration_1",
  operation: { type: "tools/call", tool: "copy_file", capability: "write" } as const,
};

describe("Google Drive MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.getAccessToken.mockResolvedValue("google-access-token");
    process.env.API_INTERNAL_TOKEN = "shared-api-secret";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes opencompany's endpoint and the connection permission state", async () => {
    expect(GOOGLE_DRIVE_MCP_ENDPOINT_URL).toBe(
      "https://api.opencompany.chat/mcp/plugins/google-drive",
    );
    await expect(getGoogleDriveMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual({
      connected: true,
      integrationId: "gint_drive_latest",
      capabilityModes: { query: "ask" },
      toolModes: { create_file: "off" },
    });
  });

  it("routes runtime calls through the configured environment-local API origin", () => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.staging.opencompany.test/base");
    expect(googleDriveMcpRuntimeEndpointUrl()).toBe(
      "https://api.staging.opencompany.test/mcp/plugins/google-drive",
    );
  });

  it("validates Google access but injects only a narrow first-party ticket into MCP", async () => {
    const connection = await loadGoogleDriveMcpWorkerConnection({
      ...connectionInput,
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_drive_latest" });
    if (!connection.ok) throw new Error("Expected a connected Google Drive account.");
    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_drive_latest",
      provider: "google_drive",
    });
    const tokens = await connection.authProvider.tokens();
    expect(tokens?.access_token).not.toBe("google-access-token");
    expect(
      verifyGoogleDriveMcpTicket({
        ticket: tokens?.access_token ?? "",
        secret: "shared-api-secret",
      }),
    ).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "gint_drive_latest",
      registrationId: "registration_1",
      operation: connectionInput.operation,
    });
  });

  it("fails closed for missing credentials or legacy grants without plugin scopes", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(
      loadGoogleDriveMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "not_connected" });

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: [GOOGLE_DRIVE_READ_SCOPE],
    });
    await expect(
      loadGoogleDriveMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.getAccessToken.mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    await expect(
      loadGoogleDriveMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });
});
