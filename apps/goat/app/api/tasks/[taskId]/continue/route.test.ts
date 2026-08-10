import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { continueGoatTaskAction } from "@/lib/tasks";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  continueGoatTaskAction: vi.fn(),
}));

describe("POST /api/tasks/[taskId]/continue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: { workosUserId: "user_1", taskSpawningEnabled: true },
      workspace: { id: "workspace_1" },
    } as GoatAuthContext);
    vi.mocked(continueGoatTaskAction).mockResolvedValue({
      ok: true,
      error: null,
      messageId: "goat_chat_msg_1",
    });
  });

  it("continues a task through a stable HTTP endpoint", async () => {
    const response = await POST(
      jsonRequest({
        prompt: "Check again.",
        clientMessageId: "goat_chat_msg_1",
        mentions: [{ kind: "skill", id: "product-work" }],
      }),
      { params: Promise.resolve({ taskId: "goat_task_1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      error: null,
      messageId: "goat_chat_msg_1",
    });
    expect(continueGoatTaskAction).toHaveBeenCalledWith(
      "goat_task_1",
      "Check again.",
      "goat_chat_msg_1",
      [{ kind: "skill", id: "product-work" }],
    );
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(currentGoatUser).mockResolvedValueOnce(null as never);

    const response = await POST(jsonRequest({ prompt: "Check again." }), {
      params: Promise.resolve({ taskId: "goat_task_1" }),
    });

    expect(response.status).toBe(401);
    expect(continueGoatTaskAction).not.toHaveBeenCalled();
  });

  it("rejects malformed request bodies", async () => {
    const response = await POST(jsonRequest({ prompt: 42 }), {
      params: Promise.resolve({ taskId: "goat_task_1" }),
    });

    expect(response.status).toBe(400);
    expect(continueGoatTaskAction).not.toHaveBeenCalled();
  });

  it("preserves actionable continuation errors", async () => {
    vi.mocked(continueGoatTaskAction).mockResolvedValueOnce({
      ok: false,
      error: "Wait for this task to finish before sending another message.",
      messageId: null,
    });

    const response = await POST(jsonRequest({ prompt: "Check again." }), {
      params: Promise.resolve({ taskId: "goat_task_1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Wait for this task to finish before sending another message.",
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/tasks/goat_task_1/continue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
