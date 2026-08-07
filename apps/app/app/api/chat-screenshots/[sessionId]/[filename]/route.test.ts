import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getBlob: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@vercel/blob", () => ({
  get: mocks.getBlob,
}));

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

import { GET } from "./route";

describe("GET /api/chat-screenshots/[sessionId]/[filename]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentUser).mockResolvedValue({
      user: { workosUserId: "user_1" },
    } as never);
    mocks.getDb.mockReturnValue(queryDb([{ userWorkosId: "user_1" }]));
    mocks.getBlob.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
    });
  });

  it("requires authentication before resolving private storage", async () => {
    vi.mocked(currentUser).mockResolvedValue(null as never);

    const response = await requestScreenshot();

    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });

  it("returns 404 when the signed-in user does not own the chat", async () => {
    mocks.getDb.mockReturnValue(queryDb([{ userWorkosId: "user_2" }]));

    const response = await requestScreenshot();

    expect(response.status).toBe(404);
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });

  it("streams an owned private screenshot with defensive response headers", async () => {
    const response = await requestScreenshot();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mocks.getBlob).toHaveBeenCalledWith(
      "goat-chat/user_1/screenshots/session_1/1234-aabb.png",
      { access: "private", useCache: false },
    );
  });

  it("rejects malformed filenames without reading Blob storage", async () => {
    const response = await requestScreenshot("../secret.png");

    expect(response.status).toBe(404);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getBlob).not.toHaveBeenCalled();
  });
});

function requestScreenshot(filename = "1234-aabb.png") {
  return GET(new Request("https://app.test"), {
    params: Promise.resolve({
      sessionId: "session_1",
      filename,
    }),
  });
}

function queryDb(rows: Array<{ userWorkosId: string }>) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}
