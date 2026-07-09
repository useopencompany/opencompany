import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { createDbGoatChatStore } from "@/lib/chat";
import { isGoatChatResumeEnabled, requestGoatChatStop } from "@/lib/chat-streams";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbGoatChatStore: vi.fn(),
}));

vi.mock("@/lib/chat-streams", () => ({
  isGoatChatResumeEnabled: vi.fn(),
  requestGoatChatStop: vi.fn(),
}));

describe("POST /api/chat/[sessionId]/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser as unknown as () => Promise<unknown>).mockResolvedValue({
      user: { workosUserId: "user_1" },
    });
    vi.mocked(isGoatChatResumeEnabled).mockReturnValue(true);
    mockFindOpenSession({ id: "session_1" });
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(currentGoatUser as unknown as () => Promise<unknown>).mockResolvedValue(null);

    const response = await POST(stopRequest(), params("session_1"));

    expect(response.status).toBe(401);
  });

  it("is a no-op when resume is not configured", async () => {
    vi.mocked(isGoatChatResumeEnabled).mockReturnValue(false);

    const response = await POST(stopRequest(), params("session_1"));

    await expect(response.json()).resolves.toEqual({ ok: true, stopped: false });
    expect(requestGoatChatStop).not.toHaveBeenCalled();
  });

  it("is a no-op for sessions the user does not own", async () => {
    mockFindOpenSession(null);

    const response = await POST(stopRequest(), params("session_1"));

    await expect(response.json()).resolves.toEqual({ ok: true, stopped: false });
    expect(requestGoatChatStop).not.toHaveBeenCalled();
  });

  it("requests a stop for the session's active stream", async () => {
    vi.mocked(requestGoatChatStop).mockResolvedValue(true);

    const response = await POST(stopRequest(), params("session_1"));

    await expect(response.json()).resolves.toEqual({ ok: true, stopped: true });
    expect(requestGoatChatStop).toHaveBeenCalledWith("session_1");
  });
});

function params(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

function stopRequest() {
  return new Request("https://goat.test/api/chat/session_1/stop", { method: "POST" });
}

function mockFindOpenSession(session: { id: string } | null) {
  vi.mocked(createDbGoatChatStore).mockReturnValue({
    findOpenSession: vi.fn(async () => session),
  } as never);
}
