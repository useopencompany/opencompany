import {
  createSlackIntegrationState,
  exchangeSlackCode,
  fetchSlackIdentity,
  SLACK_MCP_USER_SCOPES,
} from "@opencompany/agent/integrations/slack";
import { connectSlackIntegration } from "@opencompany/db/integrations";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createSlackIngress } from "./slack-ingress";

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
});
