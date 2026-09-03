import { captureIntegrationAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  createSlackIntegrationState,
  exchangeSlackCode,
  fetchSlackIdentity,
  SLACK_MCP_USER_SCOPES,
  SlackOAuthResponseError,
} from "@opencompany/agent/integrations/slack";
import { connectSlackIntegration } from "@opencompany/db/integrations";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createSlackIngress } from "./slack-ingress";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@opencompany/observability", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => logger,
}));

vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureIntegrationAddedAnalytics: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/agent/integrations/slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeSlackCode: vi.fn(),
  fetchSlackIdentity: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectSlackIntegration: vi.fn(async () => ({ integrationId: "gint_slack" })),
}));
vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));

const db = { sentinel: "db" };

function ingress(
  input: {
    authError?: ApiError;
    refresh?: (input: { userWorkosId: string; workspaceIds: string[] }) => Promise<void>;
  } = {},
) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "member" },
  ] as never);
  return createSlackIngress({
    db,
    identify: async () => {
      if (input.authError) throw input.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        credentialKind: "browser_cookie",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
    ...(input.refresh ? { refreshPluginRegistrations: input.refresh } : {}),
  });
}

describe("Slack plugin OAuth ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("OPENCOMPANY_SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubEnv("OPENCOMPANY_SLACK_STATE_SECRET", "slack-state-secret-slack-state-secret");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    vi.mocked(exchangeSlackCode).mockResolvedValue({
      teamId: "T123",
      teamName: "Acme",
      authedUserId: "U123",
      accessToken: "xoxp-slack-token",
      scopes: [...SLACK_MCP_USER_SCOPES],
    });
    vi.mocked(fetchSlackIdentity).mockResolvedValue({
      userName: "Ada",
      userEmail: "ada@acme.example",
      teamDomain: "acme",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("always starts Slack's dedicated user consent flow with MCP scopes", async () => {
    const response = await ingress().start(
      new Request("https://api.example.com/integrations/slack/start"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://slack.com/oauth/v2_user/authorize");
    expect(location.searchParams.get("scope")?.split(",")).toEqual([...SLACK_MCP_USER_SCOPES]);
    expect(location.searchParams.has("user_scope")).toBe(false);
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("redirects anonymous users to sign in", async () => {
    const response = await ingress({
      authError: new ApiError(401, "authentication_required", "Authentication required."),
    }).start(new Request("https://api.example.com/integrations/slack/start"));

    expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
  });

  it("stores the user token and refreshes plugin discovery", async () => {
    const refresh = vi.fn(async () => undefined);
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });
    const response = await ingress({ refresh }).callback(
      new Request(
        `https://api.example.com/integrations/slack/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
      ),
    );

    expect(exchangeSlackCode).toHaveBeenCalledWith("oauth-code");
    expect(fetchSlackIdentity).toHaveBeenCalledWith({
      accessToken: "xoxp-slack-token",
      authedUserId: "U123",
    });
    expect(connectSlackIntegration).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      teamId: "T123",
      teamName: "Acme",
      teamDomain: "acme",
      authedUserId: "U123",
      accountName: "Ada",
      accountEmail: "ada@acme.example",
      accessToken: "xoxp-slack-token",
      scopes: [...SLACK_MCP_USER_SCOPES],
      db,
    });
    expect(refresh).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceIds: ["workspace_1"],
    });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/settings/plugins/slack");
    expect(location.searchParams.get("integration")).toBe("slack");
    expect(location.searchParams.get("setup")).toBe("connected");
  });

  it("logs discovery refresh failures without changing the successful connection result", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("Slack MCP discovery returned 503");
    });
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });

    const response = await ingress({ refresh }).callback(
      new Request(
        `https://api.example.com/integrations/slack/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
        { headers: { "Rndr-Id": "request-slack-discovery" } },
      ),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("setup")).toBe(
      "connected",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Slack plugin discovery refresh after connection failed",
      expect.objectContaining({
        event: "goat.slack_plugin_reconnect_refresh_failed",
        failure_stage: "plugin_discovery_refresh",
        request_id: "request-slack-discovery",
        error_message: "Slack MCP discovery returned 503",
      }),
    );
  });

  it("rejects state for another opencompany user before exchanging the code", async () => {
    const state = createSlackIntegrationState({
      userWorkosId: "user_other",
      returnTo: "/settings/plugins/slack",
    });
    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
      ),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "session_mismatch",
    );
    expect(exchangeSlackCode).not.toHaveBeenCalled();
  });

  it("rejects a tampered callback state", async () => {
    const response = await ingress().callback(
      new Request("https://api.example.com/integrations/slack/callback?state=garbage"),
    );

    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "invalid_state",
    );
  });

  it("logs the OAuth response shape and callback stage without credential values", async () => {
    vi.mocked(exchangeSlackCode).mockRejectedValueOnce(
      new SlackOAuthResponseError(["team.id", "authed_user.id"], {
        credentialLocation: "top_level",
        hasAuthedUserId: false,
        hasTeamId: false,
        hasEnterpriseId: true,
        isEnterpriseInstall: true,
      }),
    );
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });

    await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
        { headers: { "Rndr-Id": "request-slack-oauth" } },
      ),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Slack plugin connection failed",
      expect.objectContaining({
        event: "goat.slack_plugin_callback_failed",
        failure_stage: "oauth_exchange",
        request_id: "request-slack-oauth",
        error_message: "Slack OAuth response missing required fields: team.id, authed_user.id.",
        missing_response_fields: ["team.id", "authed_user.id"],
        oauth_response_shape: {
          credential_location: "top_level",
          has_authed_user_id: false,
          has_team_id: false,
          has_enterprise_id: true,
          is_enterprise_install: true,
        },
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("xoxp");
  });

  it.each([
    {
      stage: "identity_lookup",
      fail: () =>
        vi.mocked(fetchSlackIdentity).mockRejectedValueOnce(new Error("users.info failed")),
    },
    {
      stage: "connection_persistence",
      fail: () =>
        vi.mocked(connectSlackIntegration).mockRejectedValueOnce(new Error("database unavailable")),
    },
    {
      stage: "integration_analytics",
      fail: () =>
        vi
          .mocked(captureIntegrationAddedAnalytics)
          .mockRejectedValueOnce(new Error("analytics unavailable")),
    },
  ])("logs $stage as the callback failure stage", async ({ stage, fail }) => {
    fail();
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });

    await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
      ),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Slack plugin connection failed",
      expect.objectContaining({
        event: "goat.slack_plugin_callback_failed",
        failure_stage: stage,
      }),
    );
  });

  it("sanitizes database query details before logging a persistence failure", async () => {
    const cause = Object.assign(new Error("duplicate key"), { code: "23505" });
    vi.mocked(connectSlackIntegration).mockRejectedValueOnce(
      new Error("Failed query: insert xoxp-sensitive-value", { cause }),
    );
    const state = createSlackIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/slack",
    });

    await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
      ),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      "Slack plugin connection failed",
      expect.objectContaining({
        failure_stage: "connection_persistence",
        error_message: "Database query failed",
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("xoxp-sensitive-value");
  });
});
