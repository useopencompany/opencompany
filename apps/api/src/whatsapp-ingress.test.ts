import { createHash, createHmac } from "node:crypto";
import {
  acceptWhatsappEvent,
  completeWhatsappLink,
  deleteWhatsappBinding,
  findLinkedWhatsappBinding,
  touchWhatsappBindingInbound,
} from "@opencompany/db/whatsapp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsappIngress } from "./whatsapp-ingress";

vi.mock("@opencompany/db/whatsapp", () => ({
  acceptWhatsappEvent: vi.fn(),
  completeWhatsappLink: vi.fn(),
  findLinkedWhatsappBinding: vi.fn(),
  touchWhatsappBindingInbound: vi.fn(async () => {}),
  deleteWhatsappBinding: vi.fn(async () => {}),
  isWhatsappLinkCode: (text: string) => /^\d{12}$/.test(text.trim()),
}));
const secret = "webhook-test";
const now = new Date("2026-09-17T12:00:00Z");
const binding = {
  binding: {
    id: "binding1",
    userWorkosId: "user1",
    workspaceId: "workspace1",
    conversationId: "chat1",
  },
  whatsappEnabled: true,
  workspaceRole: "member",
};
function request(
  text = "Hi",
  options: { signature?: string; sender?: string; number?: string; id?: string } = {},
) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: options.number ?? "123" },
              messages: [
                {
                  id: options.id ?? "wamid.in",
                  from: options.sender ?? "4915112345678",
                  type: "text",
                  timestamp: String(now.getTime() / 1000),
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return new Request("https://example.com/webhooks/whatsapp/events", {
    method: "POST",
    headers: {
      "x-webhook-signature":
        options.signature ?? createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
}
function fixture() {
  const accepted = new Set<string>();
  vi.mocked(acceptWhatsappEvent).mockImplementation(async (id, handle) => {
    if (accepted.has(id)) return false;
    await handle({});
    accepted.add(id);
    return true;
  });
  const client = { sendMessage: vi.fn(async () => ({ id: "wamid.out" })) };
  const chat = {
    getConversation: vi.fn(async () => ({
      id: "chat1",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
    })),
    createMessage: vi.fn(async () => ({ runId: "run1", idempotentReplay: false })),
  };
  return {
    client,
    chat,
    ingress: createWhatsappIngress({
      db: {},
      chat: chat as never,
      defaultModel: "moonshotai/kimi-k3",
      client,
      now: () => now,
      env: {
        KAPSO_API_KEY: "test-key",
        KAPSO_PHONE_NUMBER_ID: "123",
        WHATSAPP_LINE_HANDLE: "+14155550100",
        KAPSO_WEBHOOK_SECRET: secret,
      },
    }),
  };
}
describe("WhatsApp ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findLinkedWhatsappBinding).mockResolvedValue(binding as never);
  });
  it("verifies authenticity before touching account data", async () => {
    const { ingress } = fixture();
    expect((await ingress.webhook(request("Hi", { signature: "invalid" }))).status).toBe(401);
    expect(findLinkedWhatsappBinding).not.toHaveBeenCalled();
  });
  it("ignores another receiving number and users outside the supported region", async () => {
    const { ingress, chat, client } = fixture();
    await ingress.webhook(request("Hi", { number: "456" }));
    await ingress.webhook(request("Hi", { sender: "14155551234" }));
    expect(chat.createMessage).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
  it("queues the original sender's turn with a stable message idempotency key", async () => {
    const { ingress, chat } = fixture();
    await ingress.webhook(request());
    chat.createMessage.mockResolvedValueOnce({ runId: "run1", idempotentReplay: true });
    await ingress.webhook(request());
    const key = `whatsapp:${createHash("sha256").update("123:wamid.in").digest("hex")}`;
    for (const call of chat.createMessage.mock.calls as unknown as any[][]) {
      expect(call[0]).toMatchObject({
        userId: "user1",
        workspaceId: "workspace1",
        permissions: ["chat:read", "chat:write"],
      });
      expect(call[1]).toMatchObject({
        idempotencyKey: key,
        conversationId: "chat1",
        settings: {
          whatsapp: {
            messageId: "wamid.in",
            sender: "+4915112345678",
            receivedAt: now.toISOString(),
          },
        },
      });
    }
    expect(chat.createMessage).toHaveBeenCalledTimes(1);
    expect(touchWhatsappBindingInbound).toHaveBeenCalledTimes(1);
  });
  it("pairs a code without granting an unpaired sender access to the assistant", async () => {
    const { ingress, chat, client } = fixture();
    vi.mocked(findLinkedWhatsappBinding).mockResolvedValue(null);
    await ingress.webhook(request("random text", { id: "unknown" }));
    expect(client.sendMessage).not.toHaveBeenCalled();
    vi.mocked(completeWhatsappLink).mockResolvedValue(binding.binding as never);
    await ingress.webhook(request("123456789012"));
    expect(completeWhatsappLink).toHaveBeenCalledWith(
      expect.objectContaining({ code: "123456789012", handle: "+4915112345678" }),
      {},
    );
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("You're linked") }),
    );
    vi.mocked(findLinkedWhatsappBinding).mockResolvedValue(binding as never);
    await ingress.webhook(request("123456789012"));
    expect(chat.createMessage).not.toHaveBeenCalled();
  });
  it("honors STOP and disabled membership without starting a run", async () => {
    const { ingress, chat } = fixture();
    await ingress.webhook(request("STOP"));
    expect(deleteWhatsappBinding).toHaveBeenCalledWith({ userWorkosId: "user1" }, {});
    vi.mocked(findLinkedWhatsappBinding).mockResolvedValue({
      ...binding,
      workspaceRole: null,
    } as never);
    await ingress.webhook(request("Hi", { id: "membership" }));
    expect(chat.createMessage).not.toHaveBeenCalled();
  });
  it("returns a retryable response if it cannot persist the incoming turn", async () => {
    const { ingress, chat } = fixture();
    chat.createMessage.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await ingress.webhook(request())).status).toBe(503);
    expect((await ingress.webhook(request())).status).toBe(200);
    expect(chat.createMessage).toHaveBeenCalledTimes(2);
  });
});
