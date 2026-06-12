import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";
import {
  betterstackMcpOAuth,
  braintrustMcpOAuth,
  linearMcpOAuth,
  notionMcpOAuth,
  posthogMcpOAuth,
  slackMcpOAuth,
} from "@/lib/mcp/oauth-providers";
import { sanitizeReturnTo } from "@/lib/mcp/oauth-state";

// Off-site returnTo values fall back to the app-default path; derive it from
// sanitizeReturnTo so these tests stay agnostic to the configured default.
const SAFE_FALLBACK_RETURN_TO = sanitizeReturnTo("//evil.example");

const observed = vi.hoisted(() => ({
  clientInformation: null as unknown,
}));

vi.mock("@/lib/billing/stripe", () => ({
  getAppUrl: () => "https://app.example",
}));

vi.mock("@/lib/mcp/credential-storage", () => ({
  loadMcpCredential: vi.fn(async () => null),
  saveMcpCredential: vi.fn(async () => undefined),
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(async (provider) => {
    observed.clientInformation = provider.clientInformation?.();
    await provider.saveClientInformation?.({ client_id: "dynamic_client" });
    await provider.saveCodeVerifier?.("verifier");
    await provider.saveState?.(provider.state?.() ?? "state");
    provider.redirectToAuthorization?.(new URL("https://provider.example/oauth"));
    return "REDIRECT";
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  observed.clientInformation = null;
  vi.stubEnv("MCP_OAUTH_STATE_SECRET", "state-secret");
  vi.stubEnv("SLACK_MCP_CLIENT_ID", "slack_client");
  vi.stubEnv("SLACK_MCP_CLIENT_SECRET", "slack_secret");
});

describe.each([
  ["Linear", linearMcpOAuth, "https://mcp.linear.app/mcp"],
  ["PostHog", posthogMcpOAuth, "https://mcp.posthog.com/mcp"],
  ["Better Stack", betterstackMcpOAuth, "https://mcp.betterstack.com"],
  ["Braintrust", braintrustMcpOAuth, "https://api.braintrust.dev/mcp"],
  ["Notion", notionMcpOAuth, "https://mcp.notion.com/mcp"],
])("%s MCP OAuth", (_name, provider, endpointUrl) => {
  it("uses dynamic client registration and persists OAuth state", async () => {
    const result = await provider.start({
      workspaceId: "wks_123",
      userId: "usr_123",
      serverId: `wmcps_${provider.key}`,
      returnTo: "/settings",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://provider.example/oauth",
    });
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ serverUrl: endpointUrl }),
    );
    // Dynamic-registration providers never request a static scope.
    expect(vi.mocked(auth).mock.calls[0]?.[1]).not.toHaveProperty("scope");
    expect(saveMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_123",
        serverId: `wmcps_${provider.key}`,
        kind: "oauth",
        payload: expect.objectContaining({
          clientInformation: { client_id: "dynamic_client" },
        }),
      }),
    );
  });
});

describe("Slack MCP OAuth", () => {
  it("uses env-backed client information without persisting Slack client credentials", async () => {
    const result = await slackMcpOAuth.start({
      workspaceId: "wks_123",
      userId: "usr_123",
      serverId: "wmcps_slack",
      returnTo: "/settings",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://provider.example/oauth",
    });
    expect(observed.clientInformation).toEqual({
      client_id: "slack_client",
      client_secret: "slack_secret",
    });
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: "https://mcp.slack.com/mcp",
        scope: expect.stringContaining("search:read.public"),
      }),
    );
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        scope: expect.stringContaining("channels:history"),
      }),
    );
    expect(saveMcpCredential).toHaveBeenCalled();
    for (const call of vi.mocked(saveMcpCredential).mock.calls) {
      expect(call[0].payload).not.toHaveProperty("clientInformation");
      expect(JSON.stringify(call[0].payload)).not.toContain("slack_secret");
    }
  });

  it("requires the Slack client env vars", async () => {
    vi.stubEnv("SLACK_MCP_CLIENT_ID", "");
    vi.mocked(auth).mockImplementationOnce(async (provider) => {
      provider.clientInformation();
      return "AUTHORIZED";
    });

    await expect(
      slackMcpOAuth.start({
        workspaceId: "wks_123",
        userId: "usr_123",
        serverId: "wmcps_slack",
        returnTo: "/settings",
      }),
    ).rejects.toThrow("SLACK_MCP_CLIENT_ID is required for Slack MCP OAuth.");
  });

  it("surfaces Slack env hints in start failure status reasons", () => {
    expect(slackMcpOAuth.startFailureStatusReason("SLACK_MCP_CLIENT_ID is required")).toBe(
      "Set SLACK_MCP_CLIENT_ID, then reconnect Slack.",
    );
    expect(slackMcpOAuth.startFailureStatusReason("SLACK_MCP_CLIENT_SECRET is required")).toBe(
      "Set SLACK_MCP_CLIENT_SECRET, then reconnect Slack.",
    );
  });
});

describe("MCP OAuth provider factory", () => {
  it("rejects tampered state and sanitizes the embedded returnTo", () => {
    expect(() => linearMcpOAuth.verifyState("not-a-valid-state")).toThrow(
      "Invalid MCP OAuth state.",
    );

    const state = linearMcpOAuth.createState({
      workspaceId: "wks_123",
      userId: "usr_123",
      returnTo: "//evil.example",
    });
    const [body] = state.split(".");
    expect(() => linearMcpOAuth.verifyState(`${body}.deadbeef`)).toThrow(
      "Invalid MCP OAuth state signature.",
    );
    expect(linearMcpOAuth.verifyState(state).returnTo).toBe(SAFE_FALLBACK_RETURN_TO);
  });

  it("sanitizes returnTo when appending setup status", () => {
    expect(linearMcpOAuth.appendSetupStatus("//evil.example", "connected")).toBe(
      `${SAFE_FALLBACK_RETURN_TO}?mcp=linear&setup=connected`,
    );
    expect(slackMcpOAuth.appendSetupStatus("/company/settings", "error", "session_mismatch")).toBe(
      "/company/settings?mcp=slack&setup=error&reason=session_mismatch",
    );
  });

  it("drops malformed tokens and client information when parsing stored payloads", async () => {
    vi.mocked(loadMcpCredential).mockResolvedValueOnce({
      payload: {
        clientInformation: { client_id: 42 },
        tokens: { access_token: "tok" }, // missing token_type → invalid
        codeVerifier: "verifier",
        state: "stored-state",
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });

    const payload = await linearMcpOAuth.loadPayload({
      workspaceId: "wks_123",
      serverId: "wmcps_linear",
    });

    expect(payload).toEqual({ codeVerifier: "verifier", state: "stored-state" });
  });

  it("parses well-formed stored payloads", async () => {
    vi.mocked(loadMcpCredential).mockResolvedValueOnce({
      payload: {
        clientInformation: { client_id: "client" },
        tokens: { access_token: "tok", token_type: "Bearer", refresh_token: "ref" },
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });

    const payload = await linearMcpOAuth.loadPayload({
      workspaceId: "wks_123",
      serverId: "wmcps_linear",
    });

    expect(payload).toEqual({
      clientInformation: { client_id: "client" },
      tokens: { access_token: "tok", token_type: "Bearer", refresh_token: "ref" },
    });
  });

  it("never rehydrates persisted client information for static-client providers", async () => {
    vi.mocked(loadMcpCredential).mockResolvedValueOnce({
      payload: {
        clientInformation: { client_id: "stale", client_secret: "stale_secret" },
        tokens: { access_token: "tok", token_type: "Bearer" },
      },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });

    const payload = await slackMcpOAuth.loadPayload({
      workspaceId: "wks_123",
      serverId: "wmcps_slack",
    });

    expect(payload).toEqual({
      tokens: { access_token: "tok", token_type: "Bearer" },
    });
  });
});
