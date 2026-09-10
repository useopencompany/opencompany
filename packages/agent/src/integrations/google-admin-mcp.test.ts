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
  loadGoogleAdminIntegration: mocks.loadIntegration,
}));

import { GoogleAccessAuthError } from "./google-access-token";
import {
  GOOGLE_ADMIN_MCP_ENDPOINT_URL,
  getGoogleAdminMcpIntegrationState,
  googleAdminMcpRuntimeEndpointUrl,
  loadGoogleAdminMcpWorkerConnection,
} from "./google-admin-mcp";
import { verifyGoogleAdminMcpTicket } from "./google-admin-mcp-ticket";
import { GOOGLE_ADMIN_GROUP_SCOPE, GOOGLE_ADMIN_USER_SCOPE } from "./google-admin-scopes";

const connectedRow = {
  id: "gint_google_admin",
  userWorkosId: "user_1",
  status: "connected",
  accountEmail: "ada@example.com",
  accountName: "Ada",
  statusReason: null,
  scopes: [GOOGLE_ADMIN_USER_SCOPE, GOOGLE_ADMIN_GROUP_SCOPE],
  capabilityModes: { query: "ask" },
  toolModes: { create_group: "off" },
};

const connectionInput = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  registrationId: "registration_1",
  operation: { type: "tools/call", tool: "create_user", capability: "write" } as const,
};

describe("Google Admin MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.getAccessToken.mockResolvedValue("google-access-token");
    vi.stubEnv("API_INTERNAL_TOKEN", "shared-api-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes opencompany's endpoint and the connection permission state", async () => {
    expect(GOOGLE_ADMIN_MCP_ENDPOINT_URL).toBe(
      "https://api.opencompany.chat/mcp/plugins/google-admin",
    );
    await expect(getGoogleAdminMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual({
      connected: true,
      integrationId: "gint_google_admin",
      capabilityModes: { query: "ask" },
      toolModes: { create_group: "off" },
    });
  });

  it("routes runtime calls through the configured environment-local API origin", () => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.staging.opencompany.test/base");
    expect(googleAdminMcpRuntimeEndpointUrl()).toBe(
      "https://api.staging.opencompany.test/mcp/plugins/google-admin",
    );
  });

  it("validates Google access but injects only a narrow first-party ticket into MCP", async () => {
    const connection = await loadGoogleAdminMcpWorkerConnection({
      ...connectionInput,
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_google_admin" });
    if (!connection.ok) throw new Error("Expected a connected Google Admin account.");
    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_google_admin",
      provider: "google_admin",
    });
    const tokens = await connection.authProvider.tokens();
    expect(tokens?.access_token).not.toBe("google-access-token");
    expect(
      verifyGoogleAdminMcpTicket({
        ticket: tokens?.access_token ?? "",
        secret: "shared-api-secret",
      }),
    ).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "gint_google_admin",
      registrationId: "registration_1",
      operation: connectionInput.operation,
    });
  });

  it("fails closed for missing credentials or legacy grants without plugin scopes", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(
      loadGoogleAdminMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "not_connected" });

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: [GOOGLE_ADMIN_USER_SCOPE],
    });
    await expect(
      loadGoogleAdminMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.getAccessToken.mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    await expect(
      loadGoogleAdminMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("maps an MCP 401 back to the normal reconnect path", async () => {
    const authorizationError = new Error("authorization required");
    const connection = await loadGoogleAdminMcpWorkerConnection({
      ...connectionInput,
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected Google Admin account.");

    await expect(
      connection.authProvider.validateResourceURL?.(
        GOOGLE_ADMIN_MCP_ENDPOINT_URL,
        GOOGLE_ADMIN_MCP_ENDPOINT_URL,
      ),
    ).rejects.toBe(authorizationError);
  });
});
