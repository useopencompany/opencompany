import { streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import { createGoatChatUserTurn, persistGoatChatAssistantMessage } from "@/lib/chat";
import { OPENCOMPANY_CHAT_MAX_STEPS } from "@/lib/chat-agent";
import { GOAT_BRAIN_TOOL_PART_TYPE } from "@/lib/chat-ui";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/brain-cli", () => ({
  runGoatBrainToolForUser: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbGoatChatStore: vi.fn(() => ({})),
  createGoatChatUserTurn: vi.fn(),
  newGoatChatMessageId: vi.fn(() => "assistant_1"),
  persistGoatChatAssistantMessage: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  createGoatTaskForUser: vi.fn(),
}));

vi.mock("ai", () => ({
  convertToModelMessages: vi.fn(async () => []),
  createGateway: vi.fn(() => (model: string) => ({ model })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  stepCountIs: vi.fn((count: number) => ({ count })),
  streamText: vi.fn(),
  tool: vi.fn((definition: unknown) => definition),
}));

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-key");
  });

  it("rejects unauthenticated requests", async () => {
    mockCurrentGoatUser().mockResolvedValue(null);

    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(401);
  });

  it("rejects malformed chat messages", async () => {
    mockAuth();

    const response = await POST(jsonRequest({ message: { role: "assistant" } }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid chat message.");
  });

  it("rejects oversized messages before model streaming", async () => {
    mockAuth();

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "x".repeat(GOAT_CHAT_PROMPT_MAX_LENGTH + 1) }],
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Messages can be at most");
  });

  it("wires the personal brain CLI tool into the model stream", async () => {
    mockAuth();
    mockCreateTurn();
    mockRunGoatBrainToolForUser().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "1. [inbox] Hiring note (hiring-note, score 1, updated 2026-01-01T00:00:00.000Z)",
      stderr: "",
    });
    let brainToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { goat_brain?: { execute?: unknown } } }).tools
        ?.goat_brain;
      if (typeof tool?.execute !== "function") {
        throw new Error("goat_brain execute function was not configured.");
      }
      brainToolPromise = tool.execute(
        {
          command: "query",
          flags: {
            text: "hiring",
            limit: 5,
            json: true,
          },
        },
        { toolCallId: "tool_call_1" },
      ) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const request = jsonRequest({
      model: "openai/gpt-5.4-mini",
      message: {
        id: "ui_user_1",
        role: "user",
        parts: [{ type: "text", text: "what did I say about hiring?" }],
      },
    });
    const response = await POST(request);
    await brainToolPromise;

    expect(response.status).toBe(200);
    expect(runGoatBrainToolForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      toolInput: {
        command: "query",
        flags: {
          text: "hiring",
          limit: 5,
          json: true,
        },
      },
      gatewayApiKey: "test-key",
      sourceRef: "goat-chat:user_message_1",
      chatSessionId: "session_1",
      userMessageId: "user_message_1",
      toolCallId: "tool_call_1",
      signal: request.signal,
    });
  });

  it("wires Exa-backed web_search into the model stream when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"));
    vi.stubEnv("EXA_API_KEY", "exa_test");
    mockAuth();
    mockCreateTurn();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      void url;
      void init;
      return new Response(
        JSON.stringify({
          requestId: "exa_req_123",
          searchType: "fast",
          costDollars: { total: 0.007 },
          results: [
            {
              title: "Google Blog",
              url: "https://blog.google",
              publishedDate: "2026-07-04",
              author: "Google",
              highlights: ["Google shared a current product update."],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    let webSearchToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        tools?: { web_search?: { execute?: unknown } };
      };
      expect(typedOptions.system).toContain("Current date: 2026-07-04.");
      expect(typedOptions.system).toContain("Use the web_search tool inside chat");
      const tool = typedOptions.tools?.web_search;
      if (typeof tool?.execute !== "function") {
        throw new Error("web_search execute function was not configured.");
      }
      webSearchToolPromise = tool.execute({
        query: "latest Google updates",
        recencyDays: 30,
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    try {
      const request = jsonRequest({
        model: "openai/gpt-5.4-mini",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "What are the latest updates on Google?" }],
        },
      });
      const response = await POST(request);
      const output = await webSearchToolPromise;
      const [, fetchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const fetchBody = JSON.parse(String(fetchInit.body)) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(output).toEqual({
        ok: true,
        query: "latest Google updates",
        searchedAt: "2026-07-04T12:00:00.000Z",
        results: [
          {
            title: "Google Blog",
            url: "https://blog.google",
            publishedDate: "2026-07-04",
            author: "Google",
            highlights: ["Google shared a current product update."],
          },
        ],
        requestId: "exa_req_123",
        costUsdMicros: 7000,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.exa.ai/search",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "exa_test",
          },
        }),
      );
      expect(fetchBody).toEqual({
        query: "latest Google updates",
        type: "fast",
        numResults: 5,
        startPublishedDate: "2026-06-04T12:00:00.000Z",
        contents: { highlights: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits web_search when EXA_API_KEY is absent", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    mockAuth();
    mockCreateTurn();
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        stopWhen?: unknown;
        tools?: { web_search?: unknown };
      };
      expect(typedOptions.stopWhen).toEqual({ count: OPENCOMPANY_CHAT_MAX_STEPS });
      expect(typedOptions.tools?.web_search).toBeUndefined();
      expect(typedOptions.system).not.toContain("Use the web_search tool inside chat");
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "What are the latest updates on Google?" }],
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("persists streamed tool parts when the chat stream is stopped before final text", async () => {
    mockAuth();
    mockCreateTurn();
    const toolPart = {
      type: GOAT_BRAIN_TOOL_PART_TYPE,
      toolCallId: "tool_brain_1",
      state: "input-available",
      input: { command: "query", flags: { text: "hiring" } },
    };
    mockStreamText().mockImplementation(
      () =>
        ({
          toUIMessageStreamResponse: vi.fn(
            async (options: {
              onFinish: (event: {
                responseMessage: {
                  id: string;
                  role: "assistant";
                  parts: Array<typeof toolPart>;
                };
                finishReason: string;
                isAborted: boolean;
              }) => Promise<void>;
            }) => {
              await options.onFinish({
                responseMessage: {
                  id: "assistant_1",
                  role: "assistant",
                  parts: [toolPart],
                },
                finishReason: "stop",
                isAborted: true,
              });
              return new Response(null, { status: 200 });
            },
          ),
        }) as never,
    );

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "check my hiring notes" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(persistGoatChatAssistantMessage).toHaveBeenCalledWith(
      {
        sessionId: "session_1",
        messageId: "assistant_1",
        content: "",
        taskId: null,
        debugTrace: expect.objectContaining({
          aborted: true,
          finishReason: "stop",
          uiMessageParts: [toolPart],
        }),
      },
      expect.anything(),
    );
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://goat.test/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function mockAuth() {
  mockCurrentGoatUser().mockResolvedValue({
    authUser: {
      id: "user_1",
      email: "user@example.com",
    } as never,
    user: {
      workosUserId: "user_1",
      email: "user@example.com",
      firstName: null,
      lastName: null,
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

function mockCreateTurn() {
  mockCreateGoatChatUserTurn().mockResolvedValue({
    session: {
      id: "session_1",
      model: "openai/gpt-5.4-mini",
    },
    userMessage: {
      id: "user_message_1",
    },
    messages: [],
  });
}

function mockCurrentGoatUser() {
  return vi.mocked(currentGoatUser as unknown as () => Promise<unknown>);
}

function mockCreateGoatChatUserTurn() {
  return vi.mocked(createGoatChatUserTurn as unknown as () => Promise<unknown>);
}

function mockRunGoatBrainToolForUser() {
  return vi.mocked(runGoatBrainToolForUser);
}

function mockStreamText() {
  return vi.mocked(streamText);
}
