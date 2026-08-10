import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { markGoatChatSessionSeenForUser } from "@/lib/chat";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  markGoatChatSessionSeenForUser: vi.fn(),
}));

describe("POST /api/chat/[sessionId]/seen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: { workosUserId: "user_1" },
      workspace: { id: "workspace_1" },
    } as GoatAuthContext);
    vi.mocked(markGoatChatSessionSeenForUser).mockResolvedValue(true);
  });

  it("marks the current user's chat as seen through a stable HTTP endpoint", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ sessionId: "goat_chat_1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, error: null });
    expect(markGoatChatSessionSeenForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
    });
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(currentGoatUser).mockResolvedValueOnce(null as never);

    const response = await POST(request(), {
      params: Promise.resolve({ sessionId: "goat_chat_1" }),
    });

    expect(response.status).toBe(401);
    expect(markGoatChatSessionSeenForUser).not.toHaveBeenCalled();
  });

  it("does not expose chats the current user cannot update", async () => {
    vi.mocked(markGoatChatSessionSeenForUser).mockResolvedValueOnce(false);

    const response = await POST(request(), {
      params: Promise.resolve({ sessionId: "goat_chat_other_user" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Could not mark that chat as seen.",
    });
  });
});

function request() {
  return new Request("https://goat.test/api/chat/goat_chat_1/seen", { method: "POST" });
}
