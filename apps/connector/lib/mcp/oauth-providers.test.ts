import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConnectorMcpCredential, saveConnectorMcpCredential } from "./credential-storage";
import { connectorLinearMcpOAuth } from "./oauth-providers";
import { sanitizeConnectorMcpReturnTo } from "./oauth-state";

const SAFE_FALLBACK_RETURN_TO = sanitizeConnectorMcpReturnTo("//evil.example");

vi.mock("./credential-storage", () => ({
  loadConnectorMcpCredential: vi.fn(async () => null),
  saveConnectorMcpCredential: vi.fn(async () => undefined),
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(async (provider) => {
    await provider.saveClientInformation?.({ client_id: "dynamic_client" });
    await provider.saveCodeVerifier?.("verifier");
    await provider.saveState?.(provider.state?.() ?? "state");
    provider.redirectToAuthorization?.(new URL("https://linear.example/oauth"));
    return "REDIRECT";
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONNECTOR_APP_URL", "https://connector.example");
  vi.stubEnv("CONNECTOR_MCP_OAUTH_STATE_SECRET", "connector-state-secret");
});

describe("connector Linear MCP OAuth provider", () => {
  it("uses dynamic client registration and persists OAuth state", async () => {
    const result = await connectorLinearMcpOAuth.start({
      organizationId: "corg_123",
      userId: "cusr_123",
      serverId: "cmcps_linear",
      returnTo: "/setup",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://linear.example/oauth",
    });
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: "https://mcp.linear.app/mcp" }),
    );
    expect(vi.mocked(auth).mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(saveConnectorMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "corg_123",
        serverId: "cmcps_linear",
        kind: "oauth",
        payload: expect.objectContaining({
          clientInformation: { client_id: "dynamic_client" },
        }),
      }),
    );
  });

  it("sanitizes return paths when appending setup status", () => {
    expect(connectorLinearMcpOAuth.appendSetupStatus("//evil.example", "connected")).toBe(
      `${SAFE_FALLBACK_RETURN_TO}?mcp=linear&setup=connected`,
    );
    expect(connectorLinearMcpOAuth.appendSetupStatus("/setup", "error", "session_mismatch")).toBe(
      "/setup?mcp=linear&setup=error&reason=session_mismatch",
    );
  });

  it("rejects tampered state", () => {
    const state = connectorLinearMcpOAuth.createState({
      organizationId: "corg_123",
      userId: "cusr_123",
      returnTo: "/setup",
    });
    const [body] = state.split(".");

    expect(() => connectorLinearMcpOAuth.verifyState(`${body}.deadbeef`)).toThrow(
      "Invalid Connector MCP OAuth state signature.",
    );
  });

  it("surfaces connector encryption env hints in start failure status reasons", () => {
    expect(
      connectorLinearMcpOAuth.startFailureStatusReason(
        "CONNECTOR_CREDENTIAL_ENCRYPTION_KEY is required.",
      ),
    ).toBe(
      "Set CONNECTOR_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key, then reconnect Linear.",
    );
  });

  it("drops malformed stored OAuth payload fields", async () => {
    vi.mocked(loadConnectorMcpCredential).mockResolvedValueOnce({
      payload: {
        clientInformation: { client_id: 42 },
        tokens: { token_type: "Bearer" },
        codeVerifier: "verifier",
        state: "stored-state",
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });

    const result = await connectorLinearMcpOAuth.start({
      organizationId: "corg_123",
      userId: "cusr_123",
      serverId: "cmcps_linear",
      returnTo: "/setup",
    });

    expect(result.status).toBe("redirect");
    expect(saveConnectorMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({
          clientInformation: { client_id: 42 },
          tokens: { token_type: "Bearer" },
        }),
      }),
    );
  });
});
