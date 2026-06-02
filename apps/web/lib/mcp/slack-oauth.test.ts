import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveMcpCredential } from "@/lib/mcp/credential-storage";
import { startSlackMcpOAuth } from "@/lib/mcp/slack-oauth";

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
    await provider.saveCodeVerifier?.("verifier");
    await provider.saveState?.(provider.state?.() ?? "state");
    provider.redirectToAuthorization?.(new URL("https://slack.example/oauth"));
    return "REDIRECT";
  }),
}));

describe("Slack MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observed.clientInformation = null;
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "state-secret");
    vi.stubEnv("SLACK_MCP_CLIENT_ID", "slack_client");
    vi.stubEnv("SLACK_MCP_CLIENT_SECRET", "slack_secret");
  });

  it("uses env-backed client information without persisting Slack client credentials", async () => {
    const result = await startSlackMcpOAuth({
      workspaceId: "wks_123",
      userId: "usr_123",
      serverId: "wmcps_slack",
      returnTo: "/settings",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://slack.example/oauth",
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
});
