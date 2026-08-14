import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCurrentUserRecentChats, loadCurrentChatSessionById } from "./chat";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const conversation = {
  id: "goat_chat_1",
  title: "Launch plan",
  engine: "opencompany",
  model: "anthropic/claude-sonnet-5",
  createdAt: "2026-08-13T09:00:00.000Z",
  updatedAt: "2026-08-13T10:00:00.000Z",
};

describe("canonical Chat server reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(new Headers({ Cookie: "wos-session=session" }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("loads recent Conversations through the typed API", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json({ data: [conversation], nextCursor: null, meta });
      }),
    );

    await expect(listCurrentUserRecentChats()).resolves.toEqual([
      expect.objectContaining({
        id: conversation.id,
        title: conversation.title,
        engine: conversation.engine,
        model: conversation.model,
        updatedAt: conversation.updatedAt,
      }),
    ]);
    expect(new URL((upstream as unknown as Request).url).pathname).toBe("/v1/conversations");
    expect(new URL((upstream as unknown as Request).url).search).toBe("?limit=100");
    expect((upstream as unknown as Request).headers.get("cookie")).toBe("wos-session=session");
  });

  it("loads Conversation metadata while Electric owns transcript hydration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: conversation, meta })),
    );

    await expect(loadCurrentChatSessionById(" goat_chat_1 ")).resolves.toEqual({
      id: conversation.id,
      title: conversation.title,
      engine: conversation.engine,
      model: conversation.model,
      codexComposerSettings: null,
      codexRuntime: null,
      messages: [],
    });
  });

  it("returns null only for a canonical not-found response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(loadCurrentChatSessionById("goat_chat_missing")).resolves.toBeNull();
  });
});
