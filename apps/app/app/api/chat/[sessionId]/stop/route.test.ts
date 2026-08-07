import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser } from "@/lib/auth";
import { createDbChatStore } from "@/lib/chat";
import { isChatResumeEnabled, requestChatStop } from "@/lib/chat-streams";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbChatStore: vi.fn(),
}));

vi.mock("@/lib/chat-streams", () => ({
  isChatResumeEnabled: vi.fn(),
  requestChatStop: vi.fn(),
}));

describe("POST /api/chat/[sessionId]/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentUser as unknown as () => Promise<unknown>).mockResolvedValue({
      user: { workosUserId: "user_1" },
    });
    vi.mocked(isChatResumeEnabled).mockReturnValue(true);
    mockFindOpenSession({ id: "session_1" });
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(currentUser as unknown as () => Promise<unknown>).mockResolvedValue(null);

    const response = await POST(stopRequest(), params("session_1"));

    expect(response.status).toBe(401);
  });

  it("is a no-op when resume is not configured", async () => {
    vi.mocked(isChatResumeEnabled).mockReturnValue(false);

    const response = await POST(stopRequest(), params("session_1"));

    await expect(response.json()).resolves.toEqual({ ok: true, stopped: false });
    expect(requestChatStop).not.toHaveBeenCalled();
  });

  it("is a no-op for sessions the user does not own", async () => {
    mockFindOpenSession(null);

    const response = await POST(stopRequest(), params("session_1"));

    await expect(response.json()).resolves.toEqual({ ok: true, stopped: false });
    expect(requestChatStop).not.toHaveBeenCalled();
  });

  it("requests a stop for the session's active stream", async () => {
    vi.mocked(requestChatStop).mockResolvedValue(true);

    const response = await POST(stopRequest(), params("session_1"));

    await expect(response.json()).resolves.toEqual({ ok: true, stopped: true });
    expect(requestChatStop).toHaveBeenCalledWith("session_1");
  });
});

function params(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

function stopRequest() {
  return new Request("https://goat.test/api/chat/session_1/stop", { method: "POST" });
}

function mockFindOpenSession(session: { id: string } | null) {
  vi.mocked(createDbChatStore).mockReturnValue({
    findOpenSession: vi.fn(async () => session),
  } as never);
}
