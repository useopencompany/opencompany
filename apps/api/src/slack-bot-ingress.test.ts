import { connectGoatSlackBotIntegration } from "@opencompany/db/goat-integrations";
import { listGoatWorkspacesForUser } from "@opencompany/db/goat-workspaces";
import { slackApiRequest } from "@opencompany/goat-agent/integrations/slack";
import { createGoatSlackBotState } from "@opencompany/goat-agent/integrations/slack-bot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackBotIngress } from "./slack-bot-ingress";

vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listGoatWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/db/goat-integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectGoatSlackBotIntegration: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/integrations/slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  slackApiRequest: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };

function ingress(overrides: { role?: string } = {}) {
  vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([
    {
      workspace: { id: "workspace_1", workosOrganizationId: null },
      role: overrides.role ?? "admin",
    },
  ] as never);
  return createSlackBotIngress({
    db: sentinelDb,
    identify: async () => ({
      userId: "user_1",
      organizationId: null,
      method: "session",
      activeWorkspaceId: null,
    }),
  });
}

function mintState(overrides: Record<string, unknown> = {}) {
  return createGoatSlackBotState({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    returnTo: "/settings/workspace/slack",
    ...overrides,
  });
}

describe("Slack bot ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("GOAT_SLACK_BOT_CLIENT_ID", "slack-bot-client");
    vi.stubEnv("GOAT_SLACK_BOT_CLIENT_SECRET", "slack-bot-secret");
    vi.stubEnv("GOAT_SLACK_BOT_SIGNING_SECRET", "slack-bot-signing");
    vi.stubEnv("GOAT_SLACK_BOT_STATE_SECRET", "slack-bot-state-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("redirects an admin to Slack authorization with signed state", async () => {
    const response = await ingress().start(
      new Request("https://api.example.com/integrations/slack-bot/start"),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://slack.com");
    expect(location.pathname).toBe("/oauth/v2/authorize");
    expect(location.searchParams.get("client_id")).toBe("slack-bot-client");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("blocks non-admin members from starting the install", async () => {
    const response = await ingress({ role: "member" }).start(
      new Request("https://api.example.com/integrations/slack-bot/start"),
    );
    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings/workspace/slack?integration=slack_bot&setup=error&reason=admin_required",
    );
  });

  it("rejects a tampered state with invalid_state", async () => {
    const response = await ingress().callback(
      new Request("https://api.example.com/integrations/slack-bot/callback?state=garbage&code=abc"),
    );
    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings/workspace/slack?integration=slack_bot&setup=error&reason=invalid_state",
    );
  });

  it("rejects a state minted for another workspace or a demoted admin with session_mismatch", async () => {
    const otherWorkspace = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack-bot/callback?state=${encodeURIComponent(
          mintState({ workspaceId: "workspace_other" }),
        )}&code=abc`,
      ),
    );
    expect(new URL(otherWorkspace.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "session_mismatch",
    );

    const demoted = await ingress({ role: "member" }).callback(
      new Request(
        `https://api.example.com/integrations/slack-bot/callback?state=${encodeURIComponent(
          mintState(),
        )}&code=abc`,
      ),
    );
    expect(new URL(demoted.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "session_mismatch",
    );
    expect(connectGoatSlackBotIntegration).not.toHaveBeenCalled();
  });

  it("maps Slack denial and a missing code to their reasons", async () => {
    const denied = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack-bot/callback?state=${encodeURIComponent(
          mintState(),
        )}&error=access_denied`,
      ),
    );
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "slack_denied",
    );

    const missing = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack-bot/callback?state=${encodeURIComponent(
          mintState(),
        )}`,
      ),
    );
    expect(new URL(missing.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "missing_code",
    );
    expect(connectGoatSlackBotIntegration).not.toHaveBeenCalled();
  });

  it("exchanges the code and connects the bot through the injected db", async () => {
    vi.mocked(slackApiRequest).mockResolvedValue({
      access_token: "xoxb-bot-token",
      bot_user_id: "B_1",
      scope: "app_mentions:read,chat:write",
      team: { id: "T_1", name: "Goat HQ" },
    } as never);
    vi.mocked(connectGoatSlackBotIntegration).mockResolvedValue({
      integrationId: "gint_bot_1",
    } as never);

    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack-bot/callback?state=${encodeURIComponent(
          mintState(),
        )}&code=slack-code`,
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings/workspace/slack?integration=slack_bot&setup=connected",
    );
    expect(slackApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "oauth.v2.access",
        form: expect.objectContaining({ code: "slack-code", client_id: "slack-bot-client" }),
      }),
    );
    expect(connectGoatSlackBotIntegration).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      teamId: "T_1",
      teamName: "Goat HQ",
      botUserId: "B_1",
      accessToken: "xoxb-bot-token",
      scopes: ["app_mentions:read", "chat:write"],
      db: sentinelDb,
    });
  });

  it("maps a failed exchange to connection_sync_failed", async () => {
    vi.mocked(slackApiRequest).mockRejectedValue(new Error("slack down"));
    const response = await ingress().callback(
      new Request(
        `https://api.example.com/integrations/slack-bot/callback?state=${encodeURIComponent(
          mintState(),
        )}&code=slack-code`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings/workspace/slack?integration=slack_bot&setup=error&reason=connection_sync_failed",
    );
  });
});
