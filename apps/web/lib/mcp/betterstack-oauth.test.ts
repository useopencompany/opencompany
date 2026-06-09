import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startBetterStackMcpOAuth } from "@/lib/mcp/betterstack-oauth";
import { saveMcpCredential } from "@/lib/mcp/credential-storage";

vi.mock("@/lib/billing/stripe", () => ({
  getAppUrl: () => "https://app.example",
}));

vi.mock("@/lib/mcp/credential-storage", () => ({
  loadMcpCredential: vi.fn(async () => null),
  saveMcpCredential: vi.fn(async () => undefined),
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(async (provider) => {
    await provider.saveClientInformation?.({ client_id: "betterstack_client" });
    await provider.saveCodeVerifier?.("verifier");
    await provider.saveState?.(provider.state?.() ?? "state");
    provider.redirectToAuthorization?.(new URL("https://betterstack.example/oauth"));
    return "REDIRECT";
  }),
}));

describe("Better Stack MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "state-secret");
  });

  it("uses dynamic client registration and persists Better Stack OAuth state", async () => {
    const result = await startBetterStackMcpOAuth({
      workspaceId: "wks_123",
      userId: "usr_123",
      serverId: "wmcps_betterstack",
      returnTo: "/settings",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://betterstack.example/oauth",
    });
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: "https://mcp.betterstack.com",
      }),
    );
    expect(saveMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_123",
        serverId: "wmcps_betterstack",
        kind: "oauth",
        payload: expect.objectContaining({
          clientInformation: { client_id: "betterstack_client" },
        }),
      }),
    );
  });
});
