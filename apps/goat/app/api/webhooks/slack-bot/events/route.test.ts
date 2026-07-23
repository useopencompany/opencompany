import { createHmac } from "node:crypto";
import {
  claimGoatSlackBotEvent,
  completeGoatSlackBotEvent,
  getGoatSlackBotThreadParticipation,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/goat-slack-bot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processGoatSlackBotDirectMessage,
  processGoatSlackBotMention,
  processGoatSlackBotThreadFollowUp,
} from "@/lib/slack-bot/answer";
import { POST } from "./route";

const afterTasks = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: vi.fn((task: Promise<unknown> | (() => unknown)) => {
      afterTasks.push(Promise.resolve(typeof task === "function" ? task() : task));
    }),
  };
});

vi.mock("@opencompany/db/goat-slack-bot", () => ({
  claimGoatSlackBotEvent: vi.fn(),
  completeGoatSlackBotEvent: vi.fn(async () => undefined),
  getGoatSlackBotThreadParticipation: vi.fn(async () => null),
  markGoatSlackBotIntegrationStatusForTeam: vi.fn(async () => undefined),
  releaseGoatSlackBotEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/slack-bot/answer", () => ({
  processGoatSlackBotDirectMessage: vi.fn(async () => undefined),
  processGoatSlackBotMention: vi.fn(async () => undefined),
  processGoatSlackBotThreadFollowUp: vi.fn(async () => undefined),
}));

const SIGNING_SECRET = "test-bot-signing-secret";
const CLAIM = { eventId: "Ev123", claimId: "claim_123" };

function signedEventRequest(event: Record<string, unknown>, options: { retry?: boolean } = {}) {
  const payload = {
    type: "event_callback",
    team_id: "T123",
    event_id: "Ev123",
    event,
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return new Request("https://goat.example.com/api/webhooks/slack-bot/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      ...(options.retry ? { "x-slack-retry-num": "1" } : {}),
    },
    body: rawBody,
  });
}

function mentionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    channel: "C123",
    user: "U123",
    ts: "1784196000.000100",
    text: "<@B123> what changed?",
    ...overrides,
  };
}

function threadMessageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U123",
    ts: "1784196000.000200",
    thread_ts: "1784196000.000100",
    text: "and what about churned accounts?",
    ...overrides,
  };
}

describe("POST /api/webhooks/slack-bot/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterTasks.length = 0;
    process.env.GOAT_SLACK_BOT_SIGNING_SECRET = SIGNING_SECRET;
    vi.mocked(claimGoatSlackBotEvent).mockResolvedValue(CLAIM);
    vi.mocked(getGoatSlackBotThreadParticipation).mockResolvedValue(null);
  });

  it("processes a retry when it acquires the event lease", async () => {
    const response = await POST(signedEventRequest(mentionEvent(), { retry: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await Promise.all(afterTasks);

    expect(processGoatSlackBotMention).toHaveBeenCalledOnce();
    expect(completeGoatSlackBotEvent).toHaveBeenCalledWith(CLAIM);
  });

  it("acks a concurrent or completed duplicate without answering twice", async () => {
    vi.mocked(claimGoatSlackBotEvent).mockResolvedValue(null);

    const response = await POST(signedEventRequest(mentionEvent(), { retry: true }));
    expect(await response.json()).toEqual({ ok: true, skipped: "duplicate" });
    expect(processGoatSlackBotMention).not.toHaveBeenCalled();
  });

  it("releases the lease when mention processing fails", async () => {
    vi.mocked(processGoatSlackBotMention).mockRejectedValue(new Error("gateway unavailable"));

    await POST(signedEventRequest(mentionEvent()));
    await Promise.all(afterTasks);

    expect(releaseGoatSlackBotEvent).toHaveBeenCalledWith(CLAIM);
    expect(completeGoatSlackBotEvent).not.toHaveBeenCalled();
  });

  it("drops bot echoes and system subtypes before claiming", async () => {
    const botEcho = await POST(signedEventRequest(threadMessageEvent({ bot_id: "B99" })));
    expect(await botEcho.json()).toEqual({ ok: true, dropped: true });

    const subtype = await POST(
      signedEventRequest(threadMessageEvent({ subtype: "message_changed" })),
    );
    expect(await subtype.json()).toEqual({ ok: true, dropped: true });

    expect(claimGoatSlackBotEvent).not.toHaveBeenCalled();
    expect(processGoatSlackBotThreadFollowUp).not.toHaveBeenCalled();
  });

  it("ignores channel messages outside threads and threads without bot participation", async () => {
    const topLevel = await POST(signedEventRequest(threadMessageEvent({ thread_ts: undefined })));
    expect(await topLevel.json()).toEqual({ ok: true, ignored: true });

    const unknownThread = await POST(signedEventRequest(threadMessageEvent()));
    expect(await unknownThread.json()).toEqual({ ok: true, ignored: true });
    expect(getGoatSlackBotThreadParticipation).toHaveBeenCalledWith({
      teamId: "T123",
      channelId: "C123",
      threadTs: "1784196000.000100",
    });

    expect(claimGoatSlackBotEvent).not.toHaveBeenCalled();
    expect(processGoatSlackBotThreadFollowUp).not.toHaveBeenCalled();
  });

  it("ignores thread replies that mention anyone (bot or human)", async () => {
    vi.mocked(getGoatSlackBotThreadParticipation).mockResolvedValue({
      integrationId: "goatint_1",
    });

    const mentionsBot = await POST(
      signedEventRequest(threadMessageEvent({ text: "<@B123> more please" })),
    );
    expect(await mentionsBot.json()).toEqual({ ok: true, ignored: true });

    const mentionsHuman = await POST(
      signedEventRequest(threadMessageEvent({ text: "<@UHUMAN> can you take this?" })),
    );
    expect(await mentionsHuman.json()).toEqual({ ok: true, ignored: true });

    expect(claimGoatSlackBotEvent).not.toHaveBeenCalled();
  });

  it("answers a mention-free reply in a thread the bot participates in", async () => {
    vi.mocked(getGoatSlackBotThreadParticipation).mockResolvedValue({
      integrationId: "goatint_1",
    });

    const response = await POST(signedEventRequest(threadMessageEvent()));
    expect(await response.json()).toEqual({ ok: true });
    await Promise.all(afterTasks);

    expect(processGoatSlackBotThreadFollowUp).toHaveBeenCalledOnce();
    expect(processGoatSlackBotMention).not.toHaveBeenCalled();
    expect(completeGoatSlackBotEvent).toHaveBeenCalledWith(CLAIM);
  });

  it("routes direct messages to the DM processor without a participation check", async () => {
    const response = await POST(
      signedEventRequest(
        threadMessageEvent({
          channel: "D123",
          channel_type: "im",
          thread_ts: undefined,
          text: "what's our refund policy?",
        }),
      ),
    );
    expect(await response.json()).toEqual({ ok: true });
    await Promise.all(afterTasks);

    expect(processGoatSlackBotDirectMessage).toHaveBeenCalledOnce();
    expect(getGoatSlackBotThreadParticipation).not.toHaveBeenCalled();
  });
});
