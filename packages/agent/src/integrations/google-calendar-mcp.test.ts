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
  loadGoogleCalendarIntegration: mocks.loadIntegration,
}));

import { GoogleAccessAuthError } from "./google-access-token";
import {
  GOOGLE_CALENDAR_MCP_ENDPOINT_URL,
  getGoogleCalendarMcpIntegrationState,
  googleCalendarMcpRuntimeEndpointUrl,
  loadGoogleCalendarMcpWorkerConnection,
} from "./google-calendar-mcp";
import { verifyGoogleCalendarMcpTicket } from "./google-calendar-mcp-ticket";
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

const connectionInput = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  registrationId: "registration_1",
  operation: { type: "tools/call", tool: "create_event", capability: "write" } as const,
};

describe("Google Calendar MCP connection", () => {
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
    expect(GOOGLE_CALENDAR_MCP_ENDPOINT_URL).toBe(
      "https://api.opencompany.chat/mcp/plugins/google-calendar",
    );
    await expect(getGoogleCalendarMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual(
      {
        connected: true,
        integrationId: "gint_google_calendar",
        capabilityModes: { query: "ask" },
        toolModes: { delete_event: "off" },
      },
    );
  });

  it("routes runtime calls through the configured environment-local API origin", () => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.staging.opencompany.test/base");
    expect(googleCalendarMcpRuntimeEndpointUrl()).toBe(
      "https://api.staging.opencompany.test/mcp/plugins/google-calendar",
    );
  });

  it("validates Google access but injects only a narrow first-party ticket into MCP", async () => {
    const connection = await loadGoogleCalendarMcpWorkerConnection({
      ...connectionInput,
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
    const tokens = await connection.authProvider.tokens();
    expect(tokens?.access_token).not.toBe("google-access-token");
    expect(
      verifyGoogleCalendarMcpTicket({
        ticket: tokens?.access_token ?? "",
        secret: "shared-api-secret",
      }),
    ).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "gint_google_calendar",
      registrationId: "registration_1",
      operation: connectionInput.operation,
    });
  });

  it("fails closed for missing credentials or legacy grants without plugin scopes", async () => {
    mocks.loadIntegration.mockResolvedValueOnce(null);
    await expect(
      loadGoogleCalendarMcpWorkerConnection({
        ...connectionInput,
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
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.getAccessToken.mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    await expect(
      loadGoogleCalendarMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("maps an MCP 401 back to the normal reconnect path", async () => {
    const authorizationError = new Error("authorization required");
    const connection = await loadGoogleCalendarMcpWorkerConnection({
      ...connectionInput,
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
  });
});
