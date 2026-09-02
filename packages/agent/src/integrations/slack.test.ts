import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackAuthorizationUrl,
  createSlackIntegrationState,
  exchangeSlackCode,
  fetchSlackIdentity,
  SLACK_MCP_USER_SCOPES,
  verifySlackIntegrationState,
} from "./slack";

describe("Slack OAuth flows", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("OPENCOMPANY_SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubEnv("OPENCOMPANY_SLACK_STATE_SECRET", "slack-state-secret-slack-state-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses Slack's dedicated user OAuth flow and advertised scopes for MCP", () => {
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });
    expect(verifySlackIntegrationState(state)).toMatchObject({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });

    const url = new URL(buildSlackAuthorizationUrl(state));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2_user/authorize");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...SLACK_MCP_USER_SCOPES]);
    expect(url.searchParams.has("user_scope")).toBe(false);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://opencompany.example.com/api/integrations/slack/callback",
    );
  });

  it("keeps invalid return paths on the official Slack plugin page", () => {
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "https://evil.example/steal",
    });

    expect(verifySlackIntegrationState(state).returnTo).toBe("/settings/plugins/slack");
  });

  it("exchanges MCP codes at oauth.v2.user.access and reads its top-level token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        access_token: "xoxp-mcp-token",
        scope: "channels:history,chat:write",
        authed_user: { id: "U123" },
        team: { id: "T123", name: "Acme" },
      }),
    );

    await expect(exchangeSlackCode("oauth-code")).resolves.toEqual({
      teamId: "T123",
      teamName: "Acme",
      authedUserId: "U123",
      accessToken: "xoxp-mcp-token",
      scopes: ["channels:history", "chat:write"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/oauth.v2.user.access",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retains the Slack workspace domain without requesting team:read", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/users.info")) {
        return Response.json({
          ok: true,
          user: { real_name: "Ada", profile: { email: "ada@acme.example" } },
        });
      }
      if (url.endsWith("/auth.test")) {
        return Response.json({ ok: true, url: "https://acme.slack.com/" });
      }
      return Response.json({ ok: false, error: "unexpected_method" });
    });

    await expect(
      fetchSlackIdentity({
        accessToken: "xoxp-mcp-token",
        authedUserId: "U123",
      }),
    ).resolves.toEqual({
      userName: "Ada",
      userEmail: "ada@acme.example",
      teamDomain: "acme",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      "https://slack.com/api/team.info",
    );
  });
});
