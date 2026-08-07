import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { createDbGoatChatStore } from "@/lib/chat";
import {
  getActiveGoatChatStream,
  getGoatChatStreamContext,
  isGoatChatResumeEnabled,
} from "@/lib/chat-streams";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbGoatChatStore: vi.fn(),
}));

vi.mock("@/lib/chat-streams", () => ({
  getActiveGoatChatStream: vi.fn(),
  getGoatChatStreamContext: vi.fn(),
  isGoatChatResumeEnabled: vi.fn(),
}));

describe("GET /api/chat/[sessionId]/stream", () => {
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

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(401);
  });

  it("returns 204 when resume is not configured", async () => {
    vi.mocked(isGoatChatResumeEnabled).mockReturnValue(false);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(204);
  });

  it("returns 204 for sessions the user does not own", async () => {
    mockFindOpenSession(null);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(204);
    expect(getActiveGoatChatStream).not.toHaveBeenCalled();
  });

  it("returns 204 when the session has no active stream", async () => {
    vi.mocked(getActiveGoatChatStream).mockResolvedValue(null);

    const response = await GET(streamRequest(), params("session_1"));

    expect(response.status).toBe(204);
  });

  it("replays the active resumable stream", async () => {
    vi.mocked(getActiveGoatChatStream).mockResolvedValue("goat_chat_stream_1");
    const resumeExistingStream = vi.fn(async () => stringStream(['data: {"type":"start"}\n\n']));
    vi.mocked(getGoatChatStreamContext).mockReturnValue({
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
  return new Request("https://goat.test/api/chat/session_1/stream");
}

function mockFindOpenSession(session: { id: string } | null) {
  vi.mocked(createDbGoatChatStore).mockReturnValue({
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
