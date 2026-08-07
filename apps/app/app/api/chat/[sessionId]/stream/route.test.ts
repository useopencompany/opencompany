import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser } from "@/lib/auth";
import { createDbChatStore } from "@/lib/chat";
import { getActiveChatStream, getChatStreamContext, isChatResumeEnabled } from "@/lib/chat-streams";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbChatStore: vi.fn(),
}));

vi.mock("@/lib/chat-streams", () => ({
  getActiveChatStream: vi.fn(),
  getChatStreamContext: vi.fn(),
  isChatResumeEnabled: vi.fn(),
}));

describe("GET /api/chat/[sessionId]/stream", () => {
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

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(401);
  });

  it("returns 204 when resume is not configured", async () => {
    vi.mocked(isChatResumeEnabled).mockReturnValue(false);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(204);
  });

  it("returns 204 for sessions the user does not own", async () => {
    mockFindOpenSession(null);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(204);
    expect(getActiveChatStream).not.toHaveBeenCalled();
  });

  it("returns 204 when the session has no active stream", async () => {
    vi.mocked(getActiveChatStream).mockResolvedValue(null);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(204);
  });

  it("replays the active resumable stream", async () => {
    vi.mocked(getActiveChatStream).mockResolvedValue("goat_chat_stream_1");
    const resumeExistingStream = vi.fn(async () => stringStream(['data: {"type":"start"}\n\n']));
    vi.mocked(getChatStreamContext).mockReturnValue({
      resumeExistingStream,
    } as never);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(resumeExistingStream).toHaveBeenCalledWith("goat_chat_stream_1");
    await expect(response.text()).resolves.toContain('"type":"start"');
  });
});

function params(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

function streamRequest() {
  return new Request("https://app.test/api/chat/session_1/stream");
}

function mockFindOpenSession(session: { id: string } | null) {
  vi.mocked(createDbChatStore).mockReturnValue({
    findOpenSession: vi.fn(async () => session),
  } as never);
}

function stringStream(chunks: string[]) {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
