import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startBraintrustMcpOAuth } from "@/lib/mcp/braintrust-oauth";
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
    await provider.saveClientInformation?.({ client_id: "braintrust_client" });
    await provider.saveCodeVerifier?.("verifier");
    await provider.saveState?.(provider.state?.() ?? "state");
    provider.redirectToAuthorization?.(new URL("https://braintrust.example/oauth"));
    return "REDIRECT";
  }),
}));

describe("Braintrust MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "state-secret");
  });

  it("uses dynamic client registration and persists Braintrust OAuth state", async () => {
    const result = await startBraintrustMcpOAuth({
      workspaceId: "wks_123",
      userId: "usr_123",
      serverId: "wmcps_braintrust",
      returnTo: "/settings",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://braintrust.example/oauth",
    });
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: "https://api.braintrust.dev/mcp",
      }),
    );
    expect(saveMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_123",
        serverId: "wmcps_braintrust",
        kind: "oauth",
        payload: expect.objectContaining({
          clientInformation: { client_id: "braintrust_client" },
        }),
      }),
    );
  });
});
