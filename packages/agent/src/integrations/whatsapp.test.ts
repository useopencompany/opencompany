import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createWhatsappClient,
  isWhatsappBetaNumber,
  isWhatsappReplyWindowOpen,
  parseWhatsappMessages,
  verifyWhatsappSignature,
} from "./whatsapp";

describe("WhatsApp transport boundary", () => {
  it("verifies the exact signed bytes and rejects malformed signatures", () => {
    const raw = '{ "entry": [] }';
    const signature = createHmac("sha256", "test-secret").update(raw).digest("hex");
    expect(verifyWhatsappSignature(raw, signature, "test-secret")).toBe(true);
    expect(verifyWhatsappSignature('{"entry":[]}', signature, "test-secret")).toBe(false);
    for (const invalid of [null, "", "abc", "z".repeat(64)])
      expect(verifyWhatsappSignature(raw, invalid, "test-secret")).toBe(false);
  });
  it("limits the beta to EEA numbers and rejects lookalike or unknown identities", () => {
    for (const number of ["+4915112345678", "+33123456789", "+4712345678", "+4231234567"])
      expect(isWhatsappBetaNumber(number)).toBe(true);
    for (const number of [
      "+14155551234",
      "+447123456789",
      "+41791234567",
      "+5511999999999",
      "US.123",
      "+49hello",
      "49",
    ])
      expect(isWhatsappBetaNumber(number)).toBe(false);
  });
  it("parses batched messages only for our receiving line without requiring phone identity", () => {
    const message = {
      id: "wamid.1",
      from: "4915112345678",
      timestamp: "1760000000",
      type: "text",
      text: { body: " hello " },
    };
    const value = (id: string) => ({
      field: "messages",
      value: {
        metadata: { phone_number_id: id },
        messages: [message, { ...message, id: "wamid.2", from: undefined, from_user_id: "US.123" }],
      },
    });
    const events = parseWhatsappMessages(
      {
        object: "whatsapp_business_account",
        entry: [{ changes: [value("ours"), value("other")] }],
      },
      "ours",
    );
    expect(events).toEqual([
      {
        messageId: "wamid.1",
        sender: "+4915112345678",
        text: "hello",
        receivedAt: "2025-10-09T08:53:20.000Z",
        phoneNumberId: "ours",
      },
    ]);
  });
  it("enforces the reply window against the original timestamp, including delayed runs", () => {
    const now = Date.parse("2026-09-17T12:00:00Z");
    expect(isWhatsappReplyWindowOpen("2026-09-16T12:00:01Z", now)).toBe(true);
    expect(isWhatsappReplyWindowOpen("2026-09-16T12:00:00Z", now)).toBe(false);
    expect(isWhatsappReplyWindowOpen("2026-09-18T12:00:00Z", now)).toBe(false);
  });
  it("uses Kapso's official endpoint and does not expose provider error bodies", async () => {
    const fetcher = vi.fn(async () => Response.json({ messages: [{ id: "wamid.out" }] }));
    const client = createWhatsappClient(
      { apiKey: "test-key", phoneNumberId: "123", lineHandle: "+14155550000" },
      fetcher,
    );
    await expect(
      client.sendMessage({ to: "+4915112345678", text: "Hi", replyTo: "wamid.in" }),
    ).resolves.toEqual({ id: "wamid.out" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.kapso.ai/meta/whatsapp/v24.0/123/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"to":"4915112345678"'),
      }),
    );
    fetcher.mockImplementationOnce(async () =>
      Response.json({ private: "customer-message" }, { status: 429 }),
    );
    await expect(client.sendMessage({ to: "+4915112345678", text: "Hi" })).rejects.toThrow(
      "HTTP 429",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
