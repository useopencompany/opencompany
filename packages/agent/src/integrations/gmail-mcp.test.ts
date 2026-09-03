import { beforeEach, describe, expect, it, vi } from "vitest";

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
  loadGmailMcpWorkerConnection,
} from "./gmail-mcp";
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

describe("Gmail MCP connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.getAccessToken.mockResolvedValue("google-access-token");
  });

  it("exposes the exact Google endpoint and connection permission state", async () => {
    expect(GMAIL_MCP_ENDPOINT_URL).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    await expect(getGmailMcpIntegrationState({ userWorkosId: "user_1" })).resolves.toEqual({
      connected: true,
      integrationId: "gint_gmail",
      capabilityModes: { query: "ask", draft: "ask", write: "ask" },
      toolModes: { trash_message: "off" },
    });
  });

  it("loads the server-side Google token into the static bearer provider", async () => {
    const connection = await loadGmailMcpWorkerConnection({
      userWorkosId: "user_1",
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
    expect(connection.authProvider.tokens()).toEqual({
      access_token: "google-access-token",
      token_type: "Bearer",
    });
  });

  it("fails closed for old grants and unusable credentials", async () => {
    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    await expect(
      loadGmailMcpWorkerConnection({
        userWorkosId: "user_1",
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
        userWorkosId: "user_1",
        onAuthorizationRequired: () => {
          throw new Error("authorization required");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "needs_reauth" });
  });

  it("requests reauthorization only when a forced refresh also fails", async () => {
    const authorizationError = new Error("authorization required");
    mocks.getAccessToken
      .mockResolvedValueOnce("google-access-token")
      .mockRejectedValueOnce(new GoogleAccessAuthError("expired"));
    const connection = await loadGmailMcpWorkerConnection({
      userWorkosId: "user_1",
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    if (!connection.ok) throw new Error("Expected a connected Gmail account.");

    await expect(
      connection.authProvider.validateResourceURL?.(GMAIL_MCP_ENDPOINT_URL, GMAIL_MCP_ENDPOINT_URL),
    ).rejects.toBe(authorizationError);
    expect(mocks.getAccessToken).toHaveBeenLastCalledWith(
      { userWorkosId: "user_1", integrationId: "gint_gmail", provider: "gmail" },
      { forceRefresh: true },
    );
  });
});
