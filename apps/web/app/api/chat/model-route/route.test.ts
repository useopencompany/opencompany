import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAutoGoatModel } from "@/lib/chat-model-router";
import { resolveGoatChatRequestContext } from "@/lib/chat-request-auth";
import { POST } from "./route";

const dbMocks = vi.hoisted(() => ({
  existingRows: [] as Array<{ model: string }>,
  attachmentRows: [] as Array<{ id: string; format: string }>,
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  queryIndex: 0,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(() => ({ select: dbMocks.select })),
}));

vi.mock("@/lib/chat-request-auth", () => ({
  resolveGoatChatRequestContext: vi.fn(),
}));

vi.mock("@/lib/chat-model-router", () => ({
  resolveAutoGoatModel: vi.fn(),
}));

const builder = {
  from: dbMocks.from,
  innerJoin: dbMocks.innerJoin,
  where: dbMocks.where,
  limit: dbMocks.limit,
};

describe("POST /api/chat/model-route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "gateway-key");
    dbMocks.existingRows = [];
    dbMocks.attachmentRows = [];
    dbMocks.queryIndex = 0;
    dbMocks.select.mockReturnValue(builder);
    dbMocks.from.mockReturnValue(builder);
    dbMocks.innerJoin.mockReturnValue(builder);
    dbMocks.where.mockReturnValue(builder);
    dbMocks.limit.mockImplementation(async () =>
      dbMocks.queryIndex++ === 0 ? dbMocks.existingRows : dbMocks.attachmentRows,
    );
    vi.mocked(resolveGoatChatRequestContext).mockResolvedValue({
      ok: true,
      context: {
        user: {
          workosUserId: "user_1",
          autoModelRoutingEnabled: true,
        },
        workspace: { id: "workspace_1" },
      },
    } as never);
    vi.mocked(resolveAutoGoatModel).mockResolvedValue({
      model: "moonshotai/kimi-k2.6",
      tier: "fast",
      reason: "simple",
      classifier: { outcome: "success", durationMs: 12 },
    } as never);
  });

  it("routes from host-verified identity and unclaimed attachment formats", async () => {
    dbMocks.attachmentRows = [{ id: "attachment_1", format: "pdf" }];

    const response = await POST(
      request({
        clientMessageId: "message_1",
        prompt: "Summarize this",
        attachmentIds: ["attachment_1"],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "moonshotai/kimi-k2.6",
      tier: "fast",
    });
    expect(getDb).toHaveBeenCalled();
    expect(resolveAutoGoatModel).toHaveBeenCalledWith({
      prompt: "Summarize this",
      attachments: [{ kind: "pdf" }],
      gatewayApiKey: "gateway-key",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
  });

  it("reuses the persisted model when an Auto command retries after commit", async () => {
    dbMocks.existingRows = [{ model: "anthropic/claude-sonnet-5" }];
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "");

    const response = await POST(
      request({
        clientMessageId: "message_committed",
        prompt: "Summarize this",
        attachmentIds: ["attachment_already_claimed"],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "anthropic/claude-sonnet-5",
      outcome: "replayed",
    });
    expect(resolveAutoGoatModel).not.toHaveBeenCalled();
    expect(dbMocks.select).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an attachment is not owned and available in the active workspace", async () => {
    const response = await POST(
      request({
        clientMessageId: "message_1",
        prompt: "Summarize this",
        attachmentIds: ["attachment_other"],
      }),
    );

    expect(response.status).toBe(400);
    expect(resolveAutoGoatModel).not.toHaveBeenCalled();
  });

  it("honors the per-user Auto routing gate", async () => {
    vi.mocked(resolveGoatChatRequestContext).mockResolvedValue({
      ok: true,
      context: {
        user: { workosUserId: "user_1", autoModelRoutingEnabled: false },
        workspace: { id: "workspace_1" },
      },
    } as never);

    const response = await POST(
      request({ clientMessageId: "message_1", prompt: "Hello", attachmentIds: [] }),
    );

    expect(response.status).toBe(403);
    expect(resolveAutoGoatModel).not.toHaveBeenCalled();
  });
});

function request(body: Record<string, unknown>) {
  return new Request("https://goat.example.com/api/chat/model-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
