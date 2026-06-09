import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveMcpCredential } from "@/lib/mcp/credential-storage";
import { startFigmaMcpOAuth } from "@/lib/mcp/figma-oauth";

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
    await provider.saveClientInformation?.({ client_id: "figma_client" });
    await provider.saveCodeVerifier?.("verifier");
    await provider.saveState?.(provider.state?.() ?? "state");
    provider.redirectToAuthorization?.(new URL("https://figma.example/oauth"));
    return "REDIRECT";
  }),
}));

describe("Figma MCP OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observed.clientInformation = null;
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", "state-secret");
  });

  it("starts dynamic OAuth against the Figma remote MCP server", async () => {
    const result = await startFigmaMcpOAuth({
      workspaceId: "wks_123",
      userId: "usr_123",
      serverId: "wmcps_figma",
      returnTo: "/settings",
    });

    expect(result).toEqual({
      status: "redirect",
      redirectUrl: "https://figma.example/oauth",
    });
    expect(observed.clientInformation).toBeUndefined();
    expect(auth).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        serverUrl: "https://mcp.figma.com/mcp",
      }),
    );
    expect(saveMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_123",
        serverId: "wmcps_figma",
        kind: "oauth",
        payload: expect.objectContaining({
          clientInformation: { client_id: "figma_client" },
        }),
      }),
    );
  });
});
