import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatSendUserMessageRunner } from "./send-user-message";

const dbMocks = vi.hoisted(() => ({
  countGoatImessageSendsSince: vi.fn(async () => 0),
  getSuccessfulGoatImessageSendForTurn: vi.fn(
    async (): Promise<{ id: string; createdAt: Date } | null> => null,
  ),
  recordGoatImessageSend: vi.fn(async () => undefined),
}));

const providerMocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ok: true as const, providerMessageId: "msg_1" })),
}));

vi.mock("@opencompany/db/goat-imessage", () => ({
  countGoatImessageSendsSince: dbMocks.countGoatImessageSendsSince,
  getSuccessfulGoatImessageSendForTurn: dbMocks.getSuccessfulGoatImessageSendForTurn,
  recordGoatImessageSend: dbMocks.recordGoatImessageSend,
}));

vi.mock("./provider", () => ({
  resolveGoatImessageProvider: () => ({ name: "log", send: providerMocks.send }),
}));

describe("createGoatSendUserMessageRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.countGoatImessageSendsSince.mockResolvedValue(0);
    dbMocks.getSuccessfulGoatImessageSendForTurn.mockResolvedValue(null);
    providerMocks.send.mockResolvedValue({ ok: true, providerMessageId: "msg_1" });
  });

  it("records the durable turn id for sent task messages", async () => {
    const runner = createGoatSendUserMessageRunner({
      userWorkosId: "user_1",
      phoneE164: "+15551234567",
      source: "task",
      chatSessionId: "goat_chat_1",
      turnId: "turn_1",
    });

    await expect(runner(" Ship the briefing. ")).resolves.toEqual({
      ok: true,
      delivered: true,
    });

    expect(providerMocks.send).toHaveBeenCalledWith({
      to: "+15551234567",
      text: "Ship the briefing.",
    });
    expect(dbMocks.recordGoatImessageSend).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      source: "task",
      status: "sent",
      chatSessionId: "goat_chat_1",
      turnId: "turn_1",
      errorReason: null,
    });
  });

  it("returns an existing successful durable turn send without replaying the provider call", async () => {
    dbMocks.getSuccessfulGoatImessageSendForTurn.mockResolvedValue({
      id: "gims_1",
      createdAt: new Date("2026-08-01T05:23:36.000Z"),
    });
    const runner = createGoatSendUserMessageRunner({
      userWorkosId: "user_1",
      phoneE164: "+15551234567",
      source: "task",
      chatSessionId: "goat_chat_1",
      turnId: "turn_1",
    });

    await expect(runner("Ship the briefing.")).resolves.toEqual({
      ok: true,
      delivered: true,
    });

    expect(dbMocks.getSuccessfulGoatImessageSendForTurn).toHaveBeenCalledWith("turn_1");
    expect(dbMocks.countGoatImessageSendsSince).not.toHaveBeenCalled();
    expect(providerMocks.send).not.toHaveBeenCalled();
    expect(dbMocks.recordGoatImessageSend).not.toHaveBeenCalled();
  });
});
