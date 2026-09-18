import { describe, expect, it, vi } from "vitest";
import { createWhatsappDelivery, readWhatsappInboundSettings } from "./whatsapp-delivery";

function fixture(overrides: Record<string, unknown> = {}) {
  const claimed = new Set<string>();
  const client = { sendMessage: vi.fn(async () => ({ id: "wamid.out" })) };
  const store = {
    claim: vi.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
    settle: vi.fn(async () => {}),
  };
  const authorize = vi.fn(async () => true);
  const args = {
    config: { apiKey: "test-key", phoneNumberId: "123", lineHandle: "+14155550000" },
    inbound: {
      messageId: "wamid.in",
      sender: "+4915112345678",
      phoneNumberId: "123",
      receivedAt: "2026-09-17T12:00:00Z",
    },
    turnId: "run1",
    conversationId: "chat1",
    userWorkosId: "user1",
    workspaceId: "workspace1",
    signal: new AbortController().signal,
    client,
    store,
    authorize,
    now: () => Date.parse("2026-09-17T12:01:00Z"),
    ...overrides,
  };
  return { args, client, store, authorize, delivery: createWhatsappDelivery(args) };
}
describe("WhatsApp personal agent delivery", () => {
  it("does not treat app turns or malformed settings as WhatsApp turns", () => {
    expect(readWhatsappInboundSettings({})).toBeNull();
    expect(readWhatsappInboundSettings({ whatsapp: { sender: "someone" } })).toBeNull();
  });
  it("sends to the fixed recipient and suppresses fallback after a reply", async () => {
    const { delivery, client } = fixture();
    await delivery.tools.whatsapp_send!.execute!({ text: "Hello" }, {} as never);
    await delivery.sendFallback("Duplicate");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+4915112345678", text: "Hello" }),
    );
  });
  it("does not resend a claimed slot when a run is replayed", async () => {
    const { args, delivery, client } = fixture();
    await delivery.tools.whatsapp_send!.execute!({ text: "First" }, {} as never);
    const fallbackReplay = createWhatsappDelivery(args);
    await expect(fallbackReplay.sendFallback("A second answer")).rejects.toThrow(
      "already attempted",
    );
    const replay = createWhatsappDelivery(args);
    await replay.tools.whatsapp_send!.execute!({ text: "Changed model answer" }, {} as never);
    await replay.sendFallback("Fallback");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("shares one durable claim when a tool send and replay fallback race", async () => {
    const { args, delivery, client } = fixture();
    const replay = createWhatsappDelivery(args);
    await Promise.allSettled([
      delivery.tools.whatsapp_send!.execute!({ text: "Tool answer" }, {} as never),
      replay.sendFallback("Fallback answer"),
    ]);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("checks unlink/access and the reply window at send time", async () => {
    const { delivery, authorize, client } = fixture();
    authorize.mockResolvedValue(false);
    await expect(
      delivery.tools.whatsapp_send!.execute!({ text: "Hello" }, {} as never),
    ).resolves.toMatchObject({ ok: false });
    expect(client.sendMessage).not.toHaveBeenCalled();
    const expired = fixture({ now: () => Date.parse("2026-09-18T12:00:00Z") });
    await expect(
      expired.delivery.tools.whatsapp_send!.execute!({ text: "Hello" }, {} as never),
    ).resolves.toMatchObject({ ok: false });
    expect(expired.client.sendMessage).not.toHaveBeenCalled();
  });
  it("does not send a fallback after an ambiguous provider failure", async () => {
    const { delivery, client, store } = fixture();
    client.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      delivery.tools.whatsapp_send!.execute!({ text: "Hello" }, {} as never),
    ).resolves.toMatchObject({ ok: false });
    await delivery.sendFallback("Duplicate");
    await delivery.tools.whatsapp_send!.execute!({ text: "Retry" }, {} as never);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.settle).toHaveBeenCalledWith("run1:reply", "failed");
  });
});
