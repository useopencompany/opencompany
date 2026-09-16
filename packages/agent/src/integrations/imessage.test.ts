import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMessagesClient,
  imessageConfig,
  parseImessageReceivedEvent,
  verifyImessageWebhookSignature,
} from "./imessage";

const SECRET = "whsec-test";
const nowMs = 1_760_000_000_000;

function sign(rawBody: string, timestamp: string, secret = SECRET) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("verifyImessageWebhookSignature", () => {
  const timestamp = String(nowMs);

  it("accepts a fresh, correctly signed body", () => {
    const rawBody = JSON.stringify({ event: "message.received" });
    expect(
      verifyImessageWebhookSignature({
        rawBody,
        timestamp,
        signature: sign(rawBody, timestamp),
        secret: SECRET,
        nowMs,
      }),
    ).toBe(true);
  });

  it("rejects a missing secret, a wrong secret, and a stale timestamp", () => {
    const rawBody = "{}";
    const base = { rawBody, timestamp, signature: sign(rawBody, timestamp), nowMs };
    expect(verifyImessageWebhookSignature({ ...base, secret: undefined })).toBe(false);
    expect(verifyImessageWebhookSignature({ ...base, secret: "other" })).toBe(false);
    const stale = String(nowMs - 6 * 60 * 1000);
    expect(
      verifyImessageWebhookSignature({
        rawBody,
        timestamp: stale,
        signature: sign(rawBody, stale),
        secret: SECRET,
        nowMs,
      }),
    ).toBe(false);
  });
});

describe("parseImessageReceivedEvent", () => {
  it("narrows message.received and ignores other events", () => {
    const event = parseImessageReceivedEvent(
      {
        event: "message.received",
        delivery_id: "dlv_1",
        timestamp: nowMs,
        data: {
          id: "msg_1",
          chat_id: "cht_1",
          sender: "+15551234567",
          text: "  hello  ",
          is_from_me: false,
          sent_at: nowMs,
        },
      },
      null,
    );
    expect(event).toEqual({
      deliveryId: "dlv_1",
      messageId: "msg_1",
      chatId: "cht_1",
      sender: "+15551234567",
      text: "hello",
      isFromMe: false,
      sentAt: new Date(nowMs),
    });
    expect(parseImessageReceivedEvent({ event: "reaction.added", data: {} }, null)).toBeNull();
    expect(parseImessageReceivedEvent("nope", null)).toBeNull();
  });

  it("falls back to the delivery header when the envelope omits the id", () => {
    const event = parseImessageReceivedEvent(
      { event: "message.received", data: { id: "msg_2", sender: "+15550000000", text: "x" } },
      "dlv_header",
    );
    expect(event?.deliveryId).toBe("dlv_header");
  });
});

describe("createMessagesClient", () => {
  it("posts from the configured line and surfaces provider errors", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/reactions")) {
        return Response.json({ error: { message: "bad reaction" } }, { status: 400 });
      }
      return Response.json({ id: "msg_out", echoed: body });
    });
    const client = createMessagesClient({
      config: { apiKey: "sk_live_x", lineHandle: "+16460000000" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const sent = await client.sendMessage({ to: "+15551234567", text: "hi", replyTo: "msg_1" });
    expect(sent).toMatchObject({
      id: "msg_out",
      echoed: { from: "+16460000000", to: "+15551234567", text: "hi", reply_to: "msg_1" },
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_live_x");
    await expect(
      client.sendReaction({ to: "+15551234567", messageId: "msg_1", type: "love" }),
    ).rejects.toThrow("bad reaction");
  });

  it("requires both the api key and the line handle", () => {
    expect(imessageConfig({ MESSAGES_API_KEY: "k" })).toBeNull();
    expect(imessageConfig({ MESSAGES_API_KEY: "k", MESSAGES_LINE_HANDLE: "+1" })).toEqual({
      apiKey: "k",
      lineHandle: "+1",
    });
  });
});
