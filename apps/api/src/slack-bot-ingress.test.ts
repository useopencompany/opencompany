import { createHmac } from "node:crypto";
import { connectGoatSlackBotIntegration } from "@opencompany/db/goat-integrations";
import {
  claimGoatSlackBotEvent,
  getGoatSlackBotThreadParticipation,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/goat-slack-bot";
import { listGoatWorkspacesForUser } from "@opencompany/db/goat-workspaces";
import { slackApiRequest } from "@opencompany/goat-agent/integrations/slack";
import { createGoatSlackBotState } from "@opencompany/goat-agent/integrations/slack-bot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerClient } from "./runner-client";
import { createSlackBotIngress } from "./slack-bot-ingress";

vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listGoatWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/db/goat-integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectGoatSlackBotIntegration: vi.fn(),
}));
vi.mock("@opencompany/db/goat-slack-bot", () => ({
  claimGoatSlackBotEvent: vi.fn(),
  getGoatSlackBotThreadParticipation: vi.fn(async () => null),
  markGoatSlackBotIntegrationStatusForTeam: vi.fn(async () => undefined),
  releaseGoatSlackBotEvent: vi.fn(async () => undefined),
}));
vi.mock("@opencompany/goat-agent/integrations/slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  slackApiRequest: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };
const runnerRequest = vi.fn(async () => ({ ok: true }));

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
    runner: {
      requestJson: runnerRequest as RunnerClient["requestJson"],
      postJson: runnerRequest as RunnerClient["postJson"],
    },
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
    vi.mocked(claimGoatSlackBotEvent).mockResolvedValue({
      eventId: "Ev123",
      claimId: "gsbec_claim",
    });
    vi.mocked(getGoatSlackBotThreadParticipation).mockResolvedValue(null);
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

  it("verifies, claims, and dispatches answer events to the runner", async () => {
    const response = await ingress().webhook(
      signedEventRequest({
        type: "app_mention",
        channel: "C123",
        user: "U123",
        ts: "1784196000.000100",
        text: "<@B123> what changed?",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(claimGoatSlackBotEvent).toHaveBeenCalledWith(
      { eventId: "Ev123", teamId: "T123" },
      sentinelDb,
    );
    expect(runnerRequest).toHaveBeenCalledWith(
      "/internal/goat/slack-bot/events",
      {
        schemaVersion: 1,
        eventId: "Ev123",
        claimId: "gsbec_claim",
        kind: "mention",
        input: {
          teamId: "T123",
          channelId: "C123",
          messageTs: "1784196000.000100",
          threadTs: null,
          text: "<@B123> what changed?",
          slackUserId: "U123",
        },
      },
      { errorFormat: "error-message" },
    );
  });

  it("releases a claim when runner dispatch fails while still acknowledging Slack", async () => {
    runnerRequest.mockRejectedValueOnce(new Error("runner unavailable"));

    const response = await ingress().webhook(
      signedEventRequest({
        type: "app_mention",
        channel: "C123",
        user: "U123",
        ts: "1784196000.000100",
        text: "<@B123> what changed?",
      }),
    );

    expect(response.status).toBe(200);
    expect(releaseGoatSlackBotEvent).toHaveBeenCalledWith(
      { eventId: "Ev123", claimId: "gsbec_claim" },
      sentinelDb,
    );
  });

  it("routes only known participating thread follow-ups", async () => {
    const unknown = await ingress().webhook(
      signedEventRequest({
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "U123",
        ts: "1784196000.000200",
        thread_ts: "1784196000.000100",
        text: "and what about churn?",
      }),
    );
    await expect(unknown.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(runnerRequest).not.toHaveBeenCalled();

    vi.mocked(getGoatSlackBotThreadParticipation).mockResolvedValue({
      integrationId: "gint_1",
    });
    const known = await ingress().webhook(
      signedEventRequest({
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "U123",
        ts: "1784196000.000200",
        thread_ts: "1784196000.000100",
        text: "and what about churn?",
      }),
    );
    await expect(known.json()).resolves.toEqual({ ok: true });
    expect(runnerRequest).toHaveBeenCalledWith(
      "/internal/goat/slack-bot/events",
      expect.objectContaining({ kind: "follow_up" }),
      { errorFormat: "error-message" },
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
