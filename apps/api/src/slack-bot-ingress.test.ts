vi.mock("@opencompany/db/session-subscriptions", () => ({
  enqueueSlackThreadReply: vi.fn(async () => 1),
}));

import { createHmac } from "node:crypto";
import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import { createSlackBotState } from "@opencompany/agent/integrations/slack-bot";
import { connectSlackBotIntegration } from "@opencompany/db/integrations";
import { enqueueSlackThreadReply } from "@opencompany/db/session-subscriptions";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerClient } from "./runner-client";
import { createSlackBotIngress } from "./slack-bot-ingress";

vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectSlackBotIntegration: vi.fn(),
}));
vi.mock("@opencompany/db/slack-bot", () => ({
  markSlackBotIntegrationStatusForTeam: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/agent/integrations/slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  slackApiRequest: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };
const runnerRequest = vi.fn(async () => ({ ok: true }));

function ingress(overrides: { role?: string } = {}) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
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
      credentialKind: "browser_cookie",
      activeWorkspaceId: null,
      activeBrainId: null,
    }),
    runner: {
      requestJson: runnerRequest as RunnerClient["requestJson"],
      postJson: runnerRequest as RunnerClient["postJson"],
    },
  });
}

function mintState(overrides: Record<string, unknown> = {}) {
  return createSlackBotState({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    returnTo: "/settings/workspace/slack",
    ...overrides,
  });
}

describe("Slack bot ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("OPENCOMPANY_SLACK_BOT_CLIENT_ID", "slack-bot-client");
    vi.stubEnv("OPENCOMPANY_SLACK_BOT_CLIENT_SECRET", "slack-bot-secret");
    vi.stubEnv("OPENCOMPANY_SLACK_BOT_SIGNING_SECRET", "slack-bot-signing");
    vi.stubEnv("OPENCOMPANY_SLACK_BOT_STATE_SECRET", "slack-bot-state-secret");
    vi.mocked(enqueueSlackThreadReply).mockResolvedValue(1);
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
      "https://opencompany.example.com/settings/workspace/slack?integration=slack_bot&setup=error&reason=admin_required",
    );
  });

  it("rejects a tampered state with invalid_state", async () => {
    const response = await ingress().callback(
      new Request("https://api.example.com/integrations/slack-bot/callback?state=garbage&code=abc"),
    );
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings/workspace/slack?integration=slack_bot&setup=error&reason=invalid_state",
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
    expect(connectSlackBotIntegration).not.toHaveBeenCalled();
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
    expect(connectSlackBotIntegration).not.toHaveBeenCalled();
  });

  it("exchanges the code and connects the bot through the injected db", async () => {
    vi.mocked(slackApiRequest).mockResolvedValue({
      access_token: "xoxb-bot-token",
      bot_user_id: "B_1",
      scope: "app_mentions:read,chat:write",
      team: { id: "T_1", name: "opencompany HQ" },
    } as never);
    vi.mocked(connectSlackBotIntegration).mockResolvedValue({
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
      "https://opencompany.example.com/settings/workspace/slack?integration=slack_bot&setup=connected",
    );
    expect(slackApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "oauth.v2.access",
        form: expect.objectContaining({ code: "slack-code", client_id: "slack-bot-client" }),
      }),
    );
    expect(connectSlackBotIntegration).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      teamId: "T_1",
      teamName: "opencompany HQ",
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
      "https://opencompany.example.com/settings/workspace/slack?integration=slack_bot&setup=error&reason=connection_sync_failed",
    );
  });

  const humanReply = {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U123",
    ts: "1784196000.000200",
    thread_ts: "1784196000.000100",
    text: "What are the DB implications?",
  };
  it("persists a signed reply before acknowledging Slack", async () => {
    const response = await ingress().webhook(signedEventRequest(humanReply));
    expect(response.status).toBe(200);
    expect(enqueueSlackThreadReply).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        eventId: "Ev123",
        teamId: "T123",
        threadTs: humanReply.thread_ts,
        text: humanReply.text,
      }),
    );
    expect(runnerRequest).not.toHaveBeenCalled();
  });
  it("returns 503 when persistence fails so Slack retries", async () => {
    vi.mocked(enqueueSlackThreadReply).mockRejectedValueOnce(new Error("database unavailable"));
    expect((await ingress().webhook(signedEventRequest(humanReply))).status).toBe(503);
  });
  it.each([
    { type: "app_mention" },
    { channel: "D123", channel_type: "im" },
    { thread_ts: undefined },
    { thread_ts: humanReply.ts },
    { bot_id: "B123" },
    { subtype: "message_changed" },
    { files: [{}] },
    { text: "" },
    { channel_type: "group" },
  ])("ignores unsupported events %j", async (overrides) => {
    const response = await ingress().webhook(signedEventRequest({ ...humanReply, ...overrides }));
    expect(response.status).toBe(200);
    expect(enqueueSlackThreadReply).not.toHaveBeenCalled();
    expect(runnerRequest).not.toHaveBeenCalled();
  });
  it("acknowledges untracked threads and duplicate events without dispatching", async () => {
    vi.mocked(enqueueSlackThreadReply).mockResolvedValueOnce(0);
    await expect((await ingress().webhook(signedEventRequest(humanReply))).json()).resolves.toEqual(
      { ok: true, accepted: 0 },
    );
  });

  it("rejects invalid signatures and answers Slack URL verification", async () => {
    const invalid = await ingress().webhook(
      new Request("https://api.example.com/webhooks/slack-bot/events", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(invalid.status).toBe(401);

    const verification = await ingress().webhook(
      signedEnvelope({ type: "url_verification", challenge: "challenge_1" }),
    );
    await expect(verification.json()).resolves.toEqual({ challenge: "challenge_1" });
  });
});

function signedEventRequest(event: Record<string, unknown>) {
  return signedEnvelope({
    type: "event_callback",
    team_id: "T123",
    event_id: "Ev123",
    event,
  });
}

function signedEnvelope(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "slack-bot-signing")
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return new Request("https://api.example.com/webhooks/slack-bot/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}
