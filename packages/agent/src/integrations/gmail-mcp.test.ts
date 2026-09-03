import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  loadIntegration: vi.fn(),
}));

vi.mock("./google-access-token", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGoogleAccessToken: mocks.getAccessToken,
}));
vi.mock("./google-data", () => ({ loadGmailIntegration: mocks.loadIntegration }));

import {
  GMAIL_MCP_ENDPOINT_URL,
  getGmailMcpIntegrationState,
  gmailMcpRuntimeEndpointUrl,
  loadGmailMcpWorkerConnection,
} from "./gmail-mcp";
import { verifyGmailMcpTicket } from "./gmail-mcp-ticket";
import { GMAIL_MODIFY_SCOPE } from "./gmail-scopes";
import { GoogleAccessAuthError } from "./google-access-token";

const connectedRow = {
  id: "gint_gmail",
  userWorkosId: "user_1",
  status: "connected",
  scopes: [GMAIL_MODIFY_SCOPE],
  capabilityModes: { query: "ask", draft: "ask", write: "ask" },
  toolModes: { trash_message: "off" },
};

const connectionInput = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  registrationId: "registration_1",
  operation: { type: "tools/call", tool: "create_draft", capability: "draft" } as const,
};

describe("Gmail MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.getAccessToken.mockResolvedValue("google-access-token");
    process.env.API_INTERNAL_TOKEN = "shared-api-secret";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes opencompany's endpoint and connection permission state", async () => {
    expect(GMAIL_MCP_ENDPOINT_URL).toBe("https://api.opencompany.chat/mcp/plugins/gmail");
    await expect(getGmailMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual({
      connected: true,
      integrationId: "gint_gmail",
      capabilityModes: { query: "ask", draft: "ask", write: "ask" },
      toolModes: { trash_message: "off" },
    });
  });

  it("routes runtime calls through the configured environment-local API origin", () => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.staging.opencompany.test/base");
    expect(gmailMcpRuntimeEndpointUrl()).toBe(
      "https://api.staging.opencompany.test/mcp/plugins/gmail",
    );
  });

  it("validates Google access but injects only a narrow first-party ticket into MCP", async () => {
    const connection = await loadGmailMcpWorkerConnection({
      ...connectionInput,
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });

    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_gmail",
      provider: "gmail",
    });
    expect(connection).toMatchObject({ ok: true, integrationId: "gint_gmail" });
    if (!connection.ok) throw new Error("Expected a connected Gmail account.");
    const tokens = await connection.authProvider.tokens();
    expect(tokens?.access_token).not.toBe("google-access-token");
    expect(
      verifyGmailMcpTicket({
        ticket: tokens?.access_token ?? "",
        secret: "shared-api-secret",
      }),
    ).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "gint_gmail",
      registrationId: "registration_1",
      operation: connectionInput.operation,
    });
  });

  it("fails closed for old grants and unusable credentials", async () => {
    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    await expect(
      loadGmailMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();

    mocks.loadIntegration.mockResolvedValueOnce(connectedRow);
    mocks.getAccessToken.mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    await expect(
      loadGmailMcpWorkerConnection({
        ...connectionInput,
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("maps an MCP 401 back to the normal reconnect path", async () => {
    const authorizationError = new Error("authorization required");
    const connection = await loadGmailMcpWorkerConnection({
      ...connectionInput,
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected Gmail account.");

    await expect(
      connection.authProvider.validateResourceURL?.(GMAIL_MCP_ENDPOINT_URL, GMAIL_MCP_ENDPOINT_URL),
    ).rejects.toBe(authorizationError);
  });
});
