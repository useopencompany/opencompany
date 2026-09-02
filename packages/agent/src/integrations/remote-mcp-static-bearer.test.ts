import { auth, type OAuthTokens } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

describe("remote MCP static bearer auth", () => {
  it("exposes only the current access token to the MCP transport", async () => {
    const provider = createRemoteMcpStaticBearerAuthProvider({
      accessToken: "provider-access-token",
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });

    expect(await provider.tokens()).toEqual({
      access_token: "provider-access-token",
      token_type: "Bearer",
    });
    expect(await provider.tokens()).not.toHaveProperty("refresh_token");
    expect(provider.clientMetadata).not.toEqual(
      expect.objectContaining({ access_token: "provider-access-token" }),
    );
  });

  it("hands every attempted OAuth mutation back to the connection plane", async () => {
    const authorizationRequired = vi.fn(() => {
      throw new Error("authorization required");
    });
    const provider = createRemoteMcpStaticBearerAuthProvider({
      accessToken: "provider-access-token",
      onAuthorizationRequired: authorizationRequired,
    });
    const nextTokens = {
      access_token: "replacement",
      token_type: "Bearer",
    } satisfies OAuthTokens;

    await expect(provider.saveTokens(nextTokens)).rejects.toThrow("authorization required");
    await expect(
      provider.validateResourceURL?.("https://mcp.example", "https://mcp.example"),
    ).rejects.toThrow("authorization required");
    await expect(
      provider.validateAuthorizationServerURL?.("https://mcp.example", "https://auth.example"),
    ).rejects.toThrow("authorization required");
    expect(authorizationRequired).toHaveBeenCalledTimes(3);
  });

  it("stops the MCP SDK's 401 recovery before authorization discovery or DCR", async () => {
    const authorizationError = new Error("authorization required");
    const provider = createRemoteMcpStaticBearerAuthProvider({
      accessToken: "provider-access-token",
      onAuthorizationRequired: () => {
        throw authorizationError;
      },
    });
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 404 }),
    );

    await expect(
      auth(provider, {
        serverUrl: "https://api.githubcopilot.com/mcp/",
        fetchFn: fetchMock,
      }),
    ).rejects.toBe(authorizationError);
    expect(fetchMock).toHaveBeenCalled();
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(String(url)).pathname).toContain("/.well-known/oauth-protected-resource");
    }
  });
});
