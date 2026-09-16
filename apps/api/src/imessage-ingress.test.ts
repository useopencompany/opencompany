import { createHmac } from "node:crypto";
import type { MessagesClient } from "@opencompany/agent/integrations/imessage";
import {
  completeImessageLink,
  findLinkedImessageBinding,
  touchImessageBindingInbound,
} from "@opencompany/db/imessage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImessageIngress } from "./imessage-ingress";

vi.mock("@opencompany/db/imessage", () => ({
  completeImessageLink: vi.fn(),
  findLinkedImessageBinding: vi.fn(),
  isImessageLinkCode: (text: string) => /^\d{6}$/.test(text.trim()),
  touchImessageBindingInbound: vi.fn(async () => undefined),
}));

const SECRET = "whsec-test";
const nowMs = 1_760_000_000_000;
const sentinelDb = { sentinel: "db" };

function signedRequest(body: unknown, overrides: { signature?: string; timestamp?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = overrides.timestamp ?? String(nowMs);
  const signature =
    overrides.signature ??
    createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return new Request("https://api.example.com/webhooks/imessage/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature,
      "x-webhook-timestamp": timestamp,
      "x-webhook-delivery-id": "dlv_header",
    },
    body: rawBody,
  });
}

function received(data: Record<string, unknown>) {
  return {
    event: "message.received",
    delivery_id: "dlv_1",
    timestamp: nowMs,
    data: { id: "msg_1", chat_id: "cht_1", sender: "+15551234567", is_from_me: false, ...data },
  };
}

const linkedBinding = {
  binding: {
    id: "imessage_binding_1",
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    status: "linked",
    handle: "+15551234567",
    conversationId: "conversation_1",
  },
  imessageEnabled: true,
  workspaceRole: "member",
};

describe("iMessage ingress", () => {
  const sendMessage = vi.fn(async () => ({ id: "obx_out" }));
  const createMessage = vi.fn(async () => ({
    conversationId: "conversation_1",
    messageId: "message_1",
    assistantMessageId: "message_2",
    runId: "run_1",
    transactionId: "1",
    idempotentReplay: false,
  }));
  const getConversation = vi.fn(async () => ({
    id: "conversation_1",
    engine: "opencompany",
    model: "moonshotai/kimi-k3",
  }));
  const ingress = () =>
    createImessageIngress({
      db: sentinelDb,
      chat: { createMessage, getConversation } as never,
      defaultModel: "moonshotai/kimi-k3",
      env: {
        MESSAGES_API_KEY: "sk_live_test",
        MESSAGES_LINE_HANDLE: "+16460000000",
        MESSAGES_WEBHOOK_SECRET: SECRET,
      },
      client: { sendMessage } as unknown as MessagesClient,
      now: () => new Date(nowMs),
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a bad signature before touching the database", async () => {
    const response = await ingress().webhook(
      signedRequest(received({ text: "hi" }), { signature: "deadbeef" }),
    );
    expect(response.status).toBe(401);
    expect(findLinkedImessageBinding).not.toHaveBeenCalled();
  });

  it("answers 503 when the deployment has no messages.dev configuration", async () => {
    const unconfigured = createImessageIngress({
      db: sentinelDb,
      chat: { createMessage, getConversation } as never,
      defaultModel: "moonshotai/kimi-k3",
      env: {},
    });
    expect((await unconfigured.webhook(signedRequest(received({ text: "hi" })))).status).toBe(503);
  });

  it("turns a text from a paired phone into a Message keyed on the delivery id", async () => {
    vi.mocked(findLinkedImessageBinding).mockResolvedValue(linkedBinding as never);
    const response = await ingress().webhook(signedRequest(received({ text: "  what's up  " })));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, runId: "run_1" });
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        workspaceId: "workspace_1",
        role: "member",
        permissions: ["chat:read", "chat:write"],
        authenticationMethod: "service",
      }),
      expect.objectContaining({
        idempotencyKey: "imessage:dlv_1",
        conversationId: "conversation_1",
        content: "what's up",
        engine: "opencompany",
        model: "moonshotai/kimi-k3",
        settings: {
          imessage: {
            deliveryId: "dlv_1",
            messageId: "msg_1",
            chatId: "cht_1",
            sender: "+15551234567",
          },
        },
      }),
    );
    expect(touchImessageBindingInbound).toHaveBeenCalledWith(
      { bindingId: "imessage_binding_1" },
      sentinelDb,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("tells a paired phone when the member turned the feature off", async () => {
    vi.mocked(findLinkedImessageBinding).mockResolvedValue({
      ...linkedBinding,
      imessageEnabled: false,
    } as never);
    await ingress().webhook(signedRequest(received({ text: "hello" })));
    expect(createMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551234567", text: expect.stringContaining("can't use") }),
    );
  });

  it("pairs an unknown phone that texts a live link code and confirms by text", async () => {
    vi.mocked(findLinkedImessageBinding).mockResolvedValue(null);
    vi.mocked(completeImessageLink).mockResolvedValue(linkedBinding.binding as never);
    const response = await ingress().webhook(signedRequest(received({ text: "123456" })));
    await expect(response.json()).resolves.toEqual({ ok: true, linked: true });
    expect(completeImessageLink).toHaveBeenCalledWith(
      { code: "123456", handle: "+15551234567", model: "moonshotai/kimi-k3" },
      sentinelDb,
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("You're linked") }),
    );
  });

  it("ignores unknown phones that do not text a code, and echoes from the line itself", async () => {
    vi.mocked(findLinkedImessageBinding).mockResolvedValue(null);
    await expect(
      (await ingress().webhook(signedRequest(received({ text: "hey there" })))).json(),
    ).resolves.toEqual({ ok: true, ignored: true });
    await expect(
      (
        await ingress().webhook(signedRequest(received({ text: "123456", is_from_me: true })))
      ).json(),
    ).resolves.toEqual({ ok: true, ignored: true });
    expect(completeImessageLink).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
