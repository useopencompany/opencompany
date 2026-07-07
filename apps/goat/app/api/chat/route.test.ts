import { streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import { createGoatChatUserTurn, persistGoatChatAssistantMessage } from "@/lib/chat";
import { OPENCOMPANY_CHAT_MAX_STEPS } from "@/lib/chat-agent";
import { GOAT_BRAIN_TOOL_PART_TYPE, START_TASK_TOOL_NAME } from "@/lib/chat-ui";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import {
  deleteGoatTaskScheduleAction,
  listCurrentUserGoatTaskSchedules,
  updateGoatTaskScheduleAction,
} from "@/lib/task-schedules";
import { createGoatTaskForUser } from "@/lib/tasks";
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

vi.mock("@/lib/codex-auth", () => ({
  isGoatCodexConnectedForUser: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  createGoatTaskForUser: vi.fn(),
}));

vi.mock("@/lib/task-schedules", () => ({
  createGoatTaskScheduleForUser: vi.fn(),
  deleteGoatTaskScheduleAction: vi.fn(),
  listCurrentUserGoatTaskSchedules: vi.fn(),
  updateGoatTaskScheduleAction: vi.fn(),
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
    mockListCurrentUserGoatTaskSchedules().mockResolvedValue([]);
    mockIsGoatCodexConnectedForUser().mockResolvedValue(false);
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

  it("injects DB-backed user context into the model stream prompt", async () => {
    mockAuth({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      timezone: "Europe/London",
    });
    mockCreateTurn();
    mockStreamText().mockImplementation((options: unknown) => {
      const system = (options as { system?: string }).system;
      expect(system).toContain("<user_context>");
      expect(system).toContain("compact user.md-style profile from the database");
      expect(system).toContain('firstName="Ada"');
      expect(system).toContain('lastName="Lovelace"');
      expect(system).toContain('email="ada@example.com"');
      expect(system).toContain('timezone="Europe/London"');
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
          parts: [{ type: "text", text: "what should I do today?" }],
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("wires brain create saves into the model stream", async () => {
    mockAuth();
    mockCreateTurn();
    mockRunGoatBrainToolForUser().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        id: "acme",
        path: "companies/acme.md",
      }),
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
          command: "create",
          flags: {
            id: "acme",
            folder: "companies",
            title: "Acme",
            type: "company",
            truth: "Acme is a company building billing tools.",
            sourceTitle: "User chat note",
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
        parts: [{ type: "text", text: "remember Acme is a company building billing tools" }],
      },
    });
    const response = await POST(request);
    await brainToolPromise;

    expect(response.status).toBe(200);
    expect(runGoatBrainToolForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      toolInput: {
        command: "create",
        flags: {
          id: "acme",
          folder: "companies",
          title: "Acme",
          type: "company",
          truth: "Acme is a company building billing tools.",
          sourceTitle: "User chat note",
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

  it("uses structured Codex mention metadata when starting a task", async () => {
    mockAuth();
    mockCreateTurn();
    mockIsGoatCodexConnectedForUser().mockResolvedValue(true);
    mockCreateGoatTaskForUser().mockResolvedValue({
      id: "task_1",
      displayId: "TASK-1",
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
    } as never);
    let startTaskToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { [START_TASK_TOOL_NAME]?: { execute?: unknown } } })
        .tools?.[START_TASK_TOOL_NAME];
      if (typeof tool?.execute !== "function") {
        throw new Error("start_task execute function was not configured.");
      }
      startTaskToolPromise = tool.execute({
        name: "Test repo access",
        prompt: "Check repo access and report whether development work can start.",
        reason: "Requires connected source-control access.",
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        mentions: [{ kind: "engine", id: "codex" }],
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "@codex check repo access" }],
        },
      }),
    );
    await startTaskToolPromise;

    expect(response.status).toBe(200);
    expect(isGoatCodexConnectedForUser).toHaveBeenCalledWith("user_1");
    expect(createGoatTaskForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
      model: "openai/gpt-5.4-mini",
      engine: "codex",
    });
  });

  it("ignores malformed mention metadata when starting a task", async () => {
    mockAuth();
    mockCreateTurn();
    mockCreateGoatTaskForUser().mockResolvedValue({
      id: "task_1",
      displayId: "TASK-1",
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
    } as never);
    let startTaskToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { [START_TASK_TOOL_NAME]?: { execute?: unknown } } })
        .tools?.[START_TASK_TOOL_NAME];
      if (typeof tool?.execute !== "function") {
        throw new Error("start_task execute function was not configured.");
      }
      startTaskToolPromise = tool.execute({
        name: "Test repo access",
        prompt: "Check repo access and report whether development work can start.",
        reason: "Requires connected source-control access.",
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        mentions: [
          { kind: "engine", id: "opencompany" },
          { kind: "tool", id: "codex" },
        ],
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "@codex check repo access" }],
        },
      }),
    );
    await startTaskToolPromise;

    expect(response.status).toBe(200);
    expect(isGoatCodexConnectedForUser).not.toHaveBeenCalled();
    const taskInput = mockCreateGoatTaskForUser().mock.calls[0]?.[0] as Record<string, unknown>;
    expect(taskInput).not.toHaveProperty("engine");
  });

  it("ignores structured Codex mention metadata when Codex is not connected", async () => {
    mockAuth();
    mockCreateTurn();
    mockIsGoatCodexConnectedForUser().mockResolvedValue(false);
    mockCreateGoatTaskForUser().mockResolvedValue({
      id: "task_1",
      displayId: "TASK-1",
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
    } as never);
    let startTaskToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { [START_TASK_TOOL_NAME]?: { execute?: unknown } } })
        .tools?.[START_TASK_TOOL_NAME];
      if (typeof tool?.execute !== "function") {
        throw new Error("start_task execute function was not configured.");
      }
      startTaskToolPromise = tool.execute({
        name: "Test repo access",
        prompt: "Check repo access and report whether development work can start.",
        reason: "Requires connected source-control access.",
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.4-mini",
        mentions: [{ kind: "engine", id: "codex" }],
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "@codex check repo access" }],
        },
      }),
    );
    await startTaskToolPromise;

    expect(response.status).toBe(200);
    expect(isGoatCodexConnectedForUser).toHaveBeenCalledWith("user_1");
    const taskInput = mockCreateGoatTaskForUser().mock.calls[0]?.[0] as Record<string, unknown>;
    expect(taskInput).not.toHaveProperty("engine");
  });

  it("wires recurring schedule edits into the model stream", async () => {
    mockAuth();
    mockCreateTurn();
    mockListCurrentUserGoatTaskSchedules().mockResolvedValue([
      {
        id: "goat_task_schedule_1",
        name: "Daily briefing",
        sourceDescription: "every day at 9",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send a daily briefing.",
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2026-07-07T09:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    mockUpdateGoatTaskScheduleAction().mockResolvedValue({
      ok: true,
      schedule: {
        id: "goat_task_schedule_1",
        name: "Daily briefing",
        cron: "0 10 * * *",
        timezone: "UTC",
        nextRunAt: new Date("2026-07-07T10:00:00.000Z"),
      },
    });
    let editToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        tools?: { edit_task_schedule?: { execute?: unknown } };
      };
      expect(typedOptions.system).toContain('name="Daily briefing"');
      const tool = typedOptions.tools?.edit_task_schedule;
      if (typeof tool?.execute !== "function") {
        throw new Error("edit_task_schedule execute function was not configured.");
      }
      editToolPromise = tool.execute({
        scheduleName: "Daily briefing",
        cron: "0 10 * * *",
      }) as Promise<unknown>;
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
          parts: [{ type: "text", text: "move my daily briefing to 10am" }],
        },
      }),
    );
    const output = await editToolPromise;

    expect(response.status).toBe(200);
    expect(updateGoatTaskScheduleAction).toHaveBeenCalledWith("goat_task_schedule_1", {
      name: "Daily briefing",
      sourceDescription: "0 10 * * * - UTC",
      cron: "0 10 * * *",
      timezone: "UTC",
      prompt: "Send a daily briefing.",
    });
    expect(output).toEqual({
      ok: true,
      scheduleId: "goat_task_schedule_1",
      scheduleName: "Daily briefing",
      cron: "0 10 * * *",
      timezone: "UTC",
      nextRunAt: "2026-07-07T10:00:00.000Z",
      status: "updated",
    });
  });

  it("wires recurring schedule deletion into the model stream", async () => {
    mockAuth();
    mockCreateTurn();
    mockListCurrentUserGoatTaskSchedules().mockResolvedValue([
      {
        id: "goat_task_schedule_1",
        name: "Daily briefing",
        sourceDescription: "every day at 9",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Send a daily briefing.",
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2026-07-07T09:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    mockDeleteGoatTaskScheduleAction().mockResolvedValue({ ok: true });
    let deleteToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { delete_task_schedule?: { execute?: unknown } } }).tools
        ?.delete_task_schedule;
      if (typeof tool?.execute !== "function") {
        throw new Error("delete_task_schedule execute function was not configured.");
      }
      deleteToolPromise = tool.execute({ scheduleName: "Daily briefing" }) as Promise<unknown>;
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
          parts: [{ type: "text", text: "delete my daily briefing routine" }],
        },
      }),
    );
    const output = await deleteToolPromise;

    expect(response.status).toBe(200);
    expect(deleteGoatTaskScheduleAction).toHaveBeenCalledWith("goat_task_schedule_1");
    expect(output).toEqual({
      ok: true,
      scheduleId: "goat_task_schedule_1",
      scheduleName: "Daily briefing",
      status: "deleted",
    });
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

function mockAuth(
  overrides: Partial<{
    email: string;
    firstName: string | null;
    lastName: string | null;
    timezone: string;
  }> = {},
) {
  const user = {
    email: overrides.email ?? "user@example.com",
    firstName: overrides.firstName ?? null,
    lastName: overrides.lastName ?? null,
    timezone: overrides.timezone ?? "UTC",
  };

  mockCurrentGoatUser().mockResolvedValue({
    authUser: {
      id: "user_1",
      email: user.email,
    } as never,
    user: {
      workosUserId: "user_1",
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: null,
      timezone: user.timezone,
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

function mockIsGoatCodexConnectedForUser() {
  return vi.mocked(isGoatCodexConnectedForUser);
}

function mockCreateGoatTaskForUser() {
  return vi.mocked(createGoatTaskForUser);
}

function mockListCurrentUserGoatTaskSchedules() {
  return vi.mocked(listCurrentUserGoatTaskSchedules);
}

function mockUpdateGoatTaskScheduleAction() {
  return vi.mocked(updateGoatTaskScheduleAction);
}

function mockDeleteGoatTaskScheduleAction() {
  return vi.mocked(deleteGoatTaskScheduleAction);
}

function mockStreamText() {
  return vi.mocked(streamText);
}
