import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWhatsAppProvider, parseWhatsAppInbound, type WhatsAppConfig } from "./index";

const config: WhatsAppConfig = {
  phoneNumberId: "111222333",
  accessToken: "test-token",
  appSecret: "test-secret",
  verifyToken: "verify-me",
  displayNumber: "15551234567",
};

function inboundBody(overrides?: { from?: string; text?: string; id?: string; name?: string }) {
  const from = overrides?.from ?? "447700900123";
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ wa_id: from, profile: { name: overrides?.name ?? "Ada" } }],
              messages: [
                {
                  from,
                  id: overrides?.id ?? "wamid.ABC",
                  timestamp: "1717000000",
                  type: "text",
                  text: { body: overrides?.text ?? "hello agent" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("verifyChallenge", () => {
  it("echoes the challenge when mode + verify token match", () => {
    const provider = createWhatsAppProvider(config);
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-me",
      "hub.challenge": "12345",
    });
    expect(provider.verifyChallenge(params)).toEqual({ ok: true, challenge: "12345" });
  });

  it("rejects a wrong verify token", () => {
    const provider = createWhatsAppProvider(config);
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "nope",
      "hub.challenge": "12345",
    });
    expect(provider.verifyChallenge(params).ok).toBe(false);
  });
});

describe("verifySignature", () => {
  it("accepts a correct sha256 HMAC of the raw body", () => {
    const provider = createWhatsAppProvider(config);
    const raw = JSON.stringify(inboundBody());
    const sig = `sha256=${createHmac("sha256", config.appSecret).update(raw, "utf8").digest("hex")}`;
    expect(provider.verifySignature(raw, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const provider = createWhatsAppProvider(config);
    const raw = JSON.stringify(inboundBody());
    const sig = `sha256=${createHmac("sha256", config.appSecret).update(raw, "utf8").digest("hex")}`;
    expect(provider.verifySignature(`${raw} `, sig)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const provider = createWhatsAppProvider(config);
    expect(provider.verifySignature("{}", null)).toBe(false);
  });
});

describe("parseInbound", () => {
  it("extracts text, sender, id, and profile name", () => {
    const parsed = parseWhatsAppInbound(inboundBody({ text: "link abc123", name: "Grace" }));
    expect(parsed).toEqual([
      {
        providerMessageId: "wamid.ABC",
        from: "447700900123",
        text: "link abc123",
        timestampSeconds: 1717000000,
        profileName: "Grace",
      },
    ]);
  });

  it("ignores non-text messages and malformed payloads", () => {
    expect(
      parseWhatsAppInbound({
        entry: [{ changes: [{ value: { messages: [{ type: "image" }] } }] }],
      }),
    ).toEqual([]);
    expect(parseWhatsAppInbound(null)).toEqual([]);
    expect(parseWhatsAppInbound({})).toEqual([]);
  });

  it("handles status-only webhooks (no messages) without throwing", () => {
    const statusBody = {
      entry: [{ changes: [{ value: { statuses: [{ status: "delivered" }] } }] }],
    };
    expect(parseWhatsAppInbound(statusBody)).toEqual([]);
  });
});

describe("buildLinkDeeplink", () => {
  it("builds a wa.me deep link with the link token prefilled", () => {
    const provider = createWhatsAppProvider(config);
    expect(provider.buildLinkDeeplink({ token: "abc123" })).toBe(
      "https://wa.me/15551234567?text=link%20abc123",
    );
  });
});
