import { createHmac } from "node:crypto";
import {
  claimGoatSlackBotEvent,
  completeGoatSlackBotEvent,
  releaseGoatSlackBotEvent,
} from "@opencompany/db/goat-slack-bot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processGoatSlackBotMention } from "@/lib/slack-bot/answer";
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
  markGoatSlackBotIntegrationStatusForTeam: vi.fn(async () => undefined),
  releaseGoatSlackBotEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/slack-bot/answer", () => ({
  processGoatSlackBotMention: vi.fn(async () => undefined),
}));

const SIGNING_SECRET = "test-bot-signing-secret";
const CLAIM = { eventId: "Ev123", claimId: "claim_123" };

function signedMentionRequest(options: { retry?: boolean } = {}) {
  const payload = {
    type: "event_callback",
    team_id: "T123",
    event_id: "Ev123",
    event: {
      type: "app_mention",
      channel: "C123",
      user: "U123",
      ts: "1784196000.000100",
      text: "<@B123> what changed?",
    },
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

describe("POST /api/webhooks/slack-bot/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterTasks.length = 0;
    process.env.GOAT_SLACK_BOT_SIGNING_SECRET = SIGNING_SECRET;
    vi.mocked(claimGoatSlackBotEvent).mockResolvedValue(CLAIM);
  });

  it("processes a retry when it acquires the event lease", async () => {
    const response = await POST(signedMentionRequest({ retry: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await Promise.all(afterTasks);

    expect(processGoatSlackBotMention).toHaveBeenCalledOnce();
    expect(completeGoatSlackBotEvent).toHaveBeenCalledWith(CLAIM);
  });

  it("acks a concurrent or completed duplicate without answering twice", async () => {
    vi.mocked(claimGoatSlackBotEvent).mockResolvedValue(null);

    const response = await POST(signedMentionRequest({ retry: true }));
    expect(await response.json()).toEqual({ ok: true, skipped: "duplicate" });
    expect(processGoatSlackBotMention).not.toHaveBeenCalled();
  });

  it("releases the lease when mention processing fails", async () => {
    vi.mocked(processGoatSlackBotMention).mockRejectedValue(new Error("gateway unavailable"));

    await POST(signedMentionRequest());
    await Promise.all(afterTasks);

    expect(releaseGoatSlackBotEvent).toHaveBeenCalledWith(CLAIM);
    expect(completeGoatSlackBotEvent).not.toHaveBeenCalled();
  });
});
