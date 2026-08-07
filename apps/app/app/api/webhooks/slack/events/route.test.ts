import { createHmac } from "node:crypto";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/integrations";
import {
  insertGoatSlackMessageEvents,
  listEnabledGoatSlackBrainSourceRoutes,
  listGoatSlackIntegrationsForTeam,
} from "@opencompany/db/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@opencompany/db/integrations", () => ({
  loadGoatIntegrationCredential: vi.fn(),
  markGoatIntegrationStatus: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/slack", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opencompany/db/slack")>();
  return {
    goatSlackSelectedConversationIds: original.goatSlackSelectedConversationIds,
    insertGoatSlackMessageEvents: vi.fn(),
    listEnabledGoatSlackBrainSourceRoutes: vi.fn(),
    listGoatSlackIntegrationsForTeam: vi.fn(),
  };
});

const SIGNING_SECRET = "test-signing-secret";

function signedRequest(
  payload: unknown,
  overrides: { timestamp?: string; signature?: string } = {},
) {
  const rawBody = JSON.stringify(payload);
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    overrides.signature ??
    `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return new Request("https://goat.example.com/api/webhooks/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function messageEnvelope(event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T012345",
    event: {
      type: "message",
      channel: "C09ABC",
      channel_type: "channel",
      user: "U01",
      ts: "1783950060.000100",
      text: "We decided to ship next week.",
      ...event,
    },
  };
}

describe("POST /api/webhooks/slack/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    vi.mocked(listGoatSlackIntegrationsForTeam).mockResolvedValue([
      { id: "gint_1", userWorkosId: "user_1", status: "connected" },
    ]);
    vi.mocked(listEnabledGoatSlackBrainSourceRoutes).mockResolvedValue([
      {
        integrationId: "gint_1",
        brainRef: "gbrain_1",
        config: { channels: [{ id: "C09ABC", name: "product" }] },
      },
    ]);
    vi.mocked(insertGoatSlackMessageEvents).mockResolvedValue(1);
  });

  it("rejects a bad signature", async () => {
    const response = await POST(signedRequest(messageEnvelope(), { signature: "v0=nope" }));
    expect(response.status).toBe(401);
    expect(insertGoatSlackMessageEvents).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp (replay guard)", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await POST(signedRequest(messageEnvelope(), { timestamp: stale }));
    expect(response.status).toBe(401);
  });

  it("answers the url_verification challenge", async () => {
    const response = await POST(
      signedRequest({ type: "url_verification", challenge: "challenge_123" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge_123" });
  });

  it("buffers a message posted in a selected channel", async () => {
    const response = await POST(signedRequest(messageEnvelope()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, buffered: 1 });
    expect(insertGoatSlackMessageEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        integrationId: "gint_1",
        userWorkosId: "user_1",
        teamId: "T012345",
        channelId: "C09ABC",
        channelType: "channel",
        messageTs: "1783950060.000100",
        text: "We decided to ship next week.",
      }),
    ]);
  });

  it("drops messages in channels no brain selected", async () => {
    const response = await POST(signedRequest(messageEnvelope({ channel: "C_OTHER" })));
    expect(await response.json()).toMatchObject({ ok: true, dropped: true });
    expect(insertGoatSlackMessageEvents).not.toHaveBeenCalled();
  });

  it("drops bot messages and noise subtypes", async () => {
    for (const event of [
      { bot_id: "B01" },
      { subtype: "message_changed" },
      { subtype: "channel_join" },
      { user: undefined },
    ]) {
      const response = await POST(signedRequest(messageEnvelope(event)));
      expect(await response.json()).toMatchObject({ ok: true, dropped: true });
    }
    expect(insertGoatSlackMessageEvents).not.toHaveBeenCalled();
  });

  it("keeps file_share and thread_broadcast subtypes", async () => {
    for (const subtype of ["file_share", "thread_broadcast"]) {
      const response = await POST(signedRequest(messageEnvelope({ subtype })));
      expect(await response.json()).toMatchObject({ ok: true, buffered: 1 });
    }
    expect(insertGoatSlackMessageEvents).toHaveBeenCalledTimes(2);
  });

  it("skips integrations that are not connected", async () => {
    vi.mocked(listGoatSlackIntegrationsForTeam).mockResolvedValue([
      { id: "gint_1", userWorkosId: "user_1", status: "needs_reauth" },
    ]);
    const response = await POST(signedRequest(messageEnvelope()));
    expect(await response.json()).toMatchObject({ ok: true, dropped: true });
    expect(insertGoatSlackMessageEvents).not.toHaveBeenCalled();
  });

  it("marks all team integrations needs_reauth on app_uninstalled", async () => {
    const response = await POST(
      signedRequest({
        type: "event_callback",
        team_id: "T012345",
        event: { type: "app_uninstalled" },
      }),
    );
    expect(await response.json()).toMatchObject({ ok: true, marked: 1 });
    expect(markGoatIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_1", status: "needs_reauth" }),
    );
  });

  it("marks only the revoked user's integration on tokens_revoked", async () => {
    vi.mocked(listGoatSlackIntegrationsForTeam).mockResolvedValue([
      { id: "gint_1", userWorkosId: "user_1", status: "connected" },
      { id: "gint_2", userWorkosId: "user_2", status: "connected" },
    ]);
    vi.mocked(loadGoatIntegrationCredential).mockImplementation(async (input) => ({
      payload: { authed_user_id: input.integrationId === "gint_1" ? "U01" : "U02" },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    }));

    const response = await POST(
      signedRequest({
        type: "event_callback",
        team_id: "T012345",
        event: { type: "tokens_revoked", tokens: { oauth: ["U02"] } },
      }),
    );
    expect(await response.json()).toMatchObject({ ok: true, marked: 1 });
    expect(markGoatIntegrationStatus).toHaveBeenCalledTimes(1);
    expect(markGoatIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_2" }),
    );
  });

  it("acks with 200 when processing fails after verification", async () => {
    vi.mocked(listGoatSlackIntegrationsForTeam).mockRejectedValue(new Error("db down"));
    const response = await POST(signedRequest(messageEnvelope()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
