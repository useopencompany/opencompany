import type { MessagesClient } from "@opencompany/agent/integrations/imessage";
import { describe, expect, it, vi } from "vitest";
import {
  createImessageDelivery,
  readImessageInboundSettings,
  withoutActionApprovals,
} from "./imessage-delivery";

const config = { apiKey: "sk_live_test", lineHandle: "+16460000000" };
const inbound = { deliveryId: "dlv_1", messageId: "msg_in", chatId: null, sender: "+15551234567" };

function fakeClient() {
  return {
    sendMessage: vi.fn(async () => ({ id: "msg_out" })),
    sendReaction: vi.fn(async () => ({ id: "rxn_1" })),
    startTyping: vi.fn(async () => undefined),
  } as unknown as MessagesClient & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendReaction: ReturnType<typeof vi.fn>;
  };
}

describe("readImessageInboundSettings", () => {
  it("reads the webhook stamp and rejects partial shapes", () => {
    expect(readImessageInboundSettings({ imessage: inbound })).toEqual(inbound);
    expect(readImessageInboundSettings({ imessage: { deliveryId: "x" } })).toBeNull();
    expect(readImessageInboundSettings({ mentions: [] })).toBeNull();
    expect(readImessageInboundSettings(undefined)).toBeNull();
  });
});

describe("createImessageDelivery", () => {
  it("sends text and reactions to the paired handle and tracks delivery", async () => {
    const client = fakeClient();
    const delivery = createImessageDelivery({
      config,
      handle: inbound.sender,
      inbound,
      signal: new AbortController().signal,
      client,
    });
    const send = delivery.tools.imessage_send.execute!;
    expect(delivery.delivered()).toBe(false);
    await expect(send({ text: "hi", reaction: "like" }, {} as never)).resolves.toEqual({
      ok: true,
      messageId: "msg_out",
      reaction: "like",
    });
    expect(client.sendReaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: inbound.sender, messageId: "msg_in", type: "like" }),
    );
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: inbound.sender, text: "hi" }),
    );
    expect(delivery.delivered()).toBe(true);
  });

  it("rejects empty input and enforces the per-turn send budget", async () => {
    const client = fakeClient();
    const delivery = createImessageDelivery({
      config,
      handle: inbound.sender,
      inbound,
      signal: new AbortController().signal,
      client,
    });
    const send = delivery.tools.imessage_send.execute!;
    await expect(send({}, {} as never)).resolves.toMatchObject({ ok: false });
    for (let index = 0; index < 3; index += 1) {
      await expect(send({ text: `m${index}` }, {} as never)).resolves.toMatchObject({ ok: true });
    }
    await expect(send({ text: "one too many" }, {} as never)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Send limit"),
    });
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("surfaces provider failures as tool errors instead of throwing", async () => {
    const client = fakeClient();
    client.sendMessage.mockRejectedValueOnce(new Error("rate_limit_error"));
    const delivery = createImessageDelivery({
      config,
      handle: inbound.sender,
      inbound,
      signal: new AbortController().signal,
      client,
    });
    await expect(
      delivery.tools.imessage_send.execute!({ text: "hi" }, {} as never),
    ).resolves.toEqual({ ok: false, error: "rate_limit_error" });
    expect(delivery.delivered()).toBe(false);
  });
});

describe("withoutActionApprovals", () => {
  it("turns an approval-gated action into a relayed failure and passes others through", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, action: "a", result: 1 }));
    const dispatcher = withoutActionApprovals({
      catalog: { sources: [], actions: [] } as never,
      needsApproval: async ({ action }) => action === "gated",
      execute,
    });
    expect(dispatcher.needsApproval).toBeUndefined();
    const denied = await dispatcher.execute({ action: "gated", params: {}, toolCallId: "t1" });
    expect(denied).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(execute).not.toHaveBeenCalled();
    await dispatcher.execute({ action: "open", params: {}, toolCallId: "t2" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
