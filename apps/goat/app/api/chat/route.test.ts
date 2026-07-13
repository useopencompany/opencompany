import { streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import { createGoatChatUserTurn, persistGoatChatAssistantMessage } from "@/lib/chat";
import { OPENCOMPANY_CHAT_MAX_STEPS } from "@/lib/chat-agent";
import { generateGoatChatTitleForMessage } from "@/lib/chat-title";
import {
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  GOAT_BRAIN_TOOL_NAME,
  GOAT_BRAIN_TOOL_PART_TYPE,
  SAVE_TO_BRAIN_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  START_TASK_TOOL_NAME,
} from "@/lib/chat-ui";
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

vi.mock("@/lib/brain-capture", () => ({
  captureToGoatBrainInbox: vi.fn(),
}));

vi.mock("@/lib/chat", () => ({
  createDbGoatChatStore: vi.fn(() => ({})),
  createGoatChatUserTurn: vi.fn(),
  newGoatChatMessageId: vi.fn(() => "assistant_1"),
  persistGoatChatAssistantMessage: vi.fn(),
}));

vi.mock("@/lib/chat-title", () => ({
  generateGoatChatTitleForMessage: vi.fn(async () => ({ ok: true, title: "Generated title" })),
}));

vi.mock("next/server", () => ({
  after: vi.fn((work: Promise<unknown>) => work),
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
  smoothStream: vi.fn(() => (chunks: unknown) => chunks),
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
        model: "openai/gpt-5.5",
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
      model: "openai/gpt-5.5",
      message: {
        id: "ui_user_1",
        role: "user",
        parts: [{ type: "text", text: "what did I say about hiring?" }],
      },
    });
    const response = await POST(request);
    await brainToolPromise;

    expect(response.status).toBe(200);
    expect(mockGenerateGoatChatTitleForMessage()).toHaveBeenCalledWith({
      sessionId: "session_1",
      messageId: "user_message_1",
      apiKey: "test-key",
    });
    expect(mockStreamText()).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          gateway: {
            user: expect.stringMatching(/^goat-[0-9a-f]{16}$/),
            tags: expect.arrayContaining([
              "app:goat",
              "env:test",
              "feature:chat",
              "chat:session_1",
              "brain:goat_brain_user_1",
            ]),
          },
        },
      }),
    );
    expect(runGoatBrainToolForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_user_1",
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
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "what should I do today?" }],
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("wires save_to_brain captures into the model stream", async () => {
    mockAuth();
    mockCreateTurn();
    mockCaptureToGoatBrainInbox().mockResolvedValue({
      ok: true,
      draftBrainId: "acme",
      path: "inbox/acme.md",
      title: "Acme",
      jobId: "goat_brain_ingest_job_1",
      enqueued: true,
    });
    let saveToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { [SAVE_TO_BRAIN_TOOL_NAME]?: { execute?: unknown } } })
        .tools?.[SAVE_TO_BRAIN_TOOL_NAME];
      if (typeof tool?.execute !== "function") {
        throw new Error("save_to_brain execute function was not configured.");
      }
      saveToolPromise = tool.execute({
        content: "Acme is a company building billing tools.",
        title: "Acme",
        intent: "company note from chat",
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const request = jsonRequest({
      model: "openai/gpt-5.5",
      message: {
        id: "ui_user_1",
        role: "user",
        parts: [{ type: "text", text: "remember Acme is a company building billing tools" }],
      },
    });
    const response = await POST(request);
    if (!saveToolPromise) throw new Error("save_to_brain was not executed.");
    const output = await saveToolPromise;

    expect(response.status).toBe(200);
    expect(output).toEqual({
      ok: true,
      draftId: "acme",
      path: "inbox/acme.md",
      title: "Acme",
      status: "captured",
    });
    expect(captureToGoatBrainInbox).toHaveBeenCalledWith({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      text: "Acme is a company building billing tools.",
      title: "Acme",
      intent: "company note from chat",
      chatSessionId: "session_1",
      userMessageId: "user_message_1",
    });
    expect(runGoatBrainToolForUser).not.toHaveBeenCalled();
  });

  it("rejects direct brain create from the chat tool before the CLI runner", async () => {
    mockAuth();
    mockCreateTurn();
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
      model: "openai/gpt-5.5",
      message: {
        id: "ui_user_1",
        role: "user",
        parts: [{ type: "text", text: "remember Acme is a company building billing tools" }],
      },
    });
    const response = await POST(request);
    if (!brainToolPromise) throw new Error("goat_brain was not executed.");
    await expect(brainToolPromise).rejects.toThrow("goat_brain command is invalid");

    expect(response.status).toBe(200);
    expect(runGoatBrainToolForUser).not.toHaveBeenCalled();
  });

  it("limits member chats to read-only brain tools and no background work", async () => {
    mockAuth({ role: "member" });
    mockCreateTurn();
    let brainToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        tools?: Record<string, { inputSchema?: unknown; execute?: unknown }>;
      };
      expect(typedOptions.system).toContain("browse-only access");
      expect(typedOptions.system).not.toContain("save_to_brain");
      expect(typedOptions.system).not.toContain("Start a task when the user asks");
      expect(typedOptions.tools?.[SAVE_TO_BRAIN_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[START_TASK_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[SCHEDULE_TASK_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[EDIT_TASK_SCHEDULE_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[DELETE_TASK_SCHEDULE_TOOL_NAME]).toBeUndefined();

      const brainTool = typedOptions.tools?.[GOAT_BRAIN_TOOL_NAME];
      const schema = brainTool?.inputSchema as {
        properties?: { command?: { enum?: string[] } };
      };
      expect(schema.properties?.command?.enum).toContain("query");
      expect(schema.properties?.command?.enum).not.toContain("append-evidence");
      expect(schema.properties?.command?.enum).not.toContain("rewrite");
      if (typeof brainTool?.execute !== "function") {
        throw new Error("goat_brain execute function was not configured.");
      }
      brainToolPromise = brainTool.execute({
        command: "append-evidence",
        flags: { id: "acme", body: "member write" },
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "add this to the brain" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    // Write commands are not in the read-only enum, so they never reach the
    // runner: normalization rejects them before runBrainCli is called.
    await expect(brainToolPromise).rejects.toThrow("goat_brain command is invalid");
    expect(runGoatBrainToolForUser).not.toHaveBeenCalled();
    expect(captureToGoatBrainInbox).not.toHaveBeenCalled();
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
    expect(listCurrentUserGoatTaskSchedules).not.toHaveBeenCalled();
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
        model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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
      model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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
        model: "openai/gpt-5.5",
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

  it("persists a fallback assistant message when the stream errors after tool activity", async () => {
    mockAuth();
    mockCreateTurn();
    mockRunGoatBrainToolForUser().mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });
    mockPersistGoatChatAssistantMessage().mockResolvedValue({} as never);
    let brainToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const tool = (options as { tools?: { goat_brain?: { execute?: unknown } } }).tools
        ?.goat_brain;
      if (typeof tool?.execute !== "function") {
        throw new Error("goat_brain execute function was not configured.");
      }
      brainToolPromise = tool.execute({
        command: "query",
        flags: { text: "board meeting", json: true },
      }) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(
          async (responseOptions: { onError: (error: unknown) => string }) => {
            await brainToolPromise;
            responseOptions.onError(new Error("stream closed"));
            await Promise.resolve();
            return new Response(null, { status: 200 });
          },
        ),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "check my board meeting notes" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(persistGoatChatAssistantMessage).toHaveBeenCalledWith(
      {
        sessionId: "session_1",
        content: "Goat stopped before it could finish.",
        taskId: null,
        debugTrace: expect.objectContaining({
          error: "stream closed",
          finishReason: "error",
        }),
      },
      expect.anything(),
    );
  });

  it("retries final assistant persistence with a server id when the streamed id write fails", async () => {
    mockAuth();
    mockCreateTurn();
    mockPersistGoatChatAssistantMessage()
      .mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"))
      .mockResolvedValueOnce({} as never);
    mockStreamText().mockImplementation(
      () =>
        ({
          toUIMessageStreamResponse: vi.fn(
            async (options: {
              onFinish: (event: {
                responseMessage: {
                  id: string;
                  role: "assistant";
                  parts: Array<{ type: "text"; text: string }>;
                };
                finishReason: string;
                isAborted: boolean;
              }) => Promise<void>;
            }) => {
              await options.onFinish({
                responseMessage: {
                  id: "assistant_1",
                  role: "assistant",
                  parts: [{ type: "text", text: "Final answer." }],
                },
                finishReason: "stop",
                isAborted: false,
              });
              return new Response(null, { status: 200 });
            },
          ),
        }) as never,
    );

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "answer me" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(persistGoatChatAssistantMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: "session_1",
        messageId: "assistant_1",
        content: "Final answer.",
      }),
      expect.anything(),
    );
    expect(persistGoatChatAssistantMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: "session_1",
        messageId: null,
        content: "Final answer.",
      }),
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
    role: "admin" | "member";
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
    workspace: {
      id: "goat_ws_user_1",
      workosOrganizationId: null,
      name: "Test Workspace",
      createdByWorkosId: "user_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    role: overrides.role ?? "admin",
    workspaces: [
      {
        workspace: {
          id: "goat_ws_user_1",
          workosOrganizationId: null,
          name: "Test Workspace",
          createdByWorkosId: "user_1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        role: overrides.role ?? "admin",
      },
    ],
    brains: [ACTIVE_BRAIN],
    activeBrain: ACTIVE_BRAIN,
  });
}

const ACTIVE_BRAIN = {
  id: "goat_brain_user_1",
  workspaceId: "goat_ws_user_1",
  name: "General",
  slug: "general",
  description: null,
  visibility: "workspace",
  createdByWorkosId: "user_1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockCreateTurn() {
  mockCreateGoatChatUserTurn().mockResolvedValue({
    session: {
      id: "session_1",
      model: "openai/gpt-5.5",
    },
    userMessage: {
      id: "user_message_1",
    },
    storedMessages: [],
    messages: [],
  });
}

function mockCurrentGoatUser() {
  return vi.mocked(currentGoatUser as unknown as () => Promise<unknown>);
}

function mockCreateGoatChatUserTurn() {
  return vi.mocked(createGoatChatUserTurn as unknown as () => Promise<unknown>);
}

function mockPersistGoatChatAssistantMessage() {
  return vi.mocked(persistGoatChatAssistantMessage as unknown as () => Promise<unknown>);
}

function mockGenerateGoatChatTitleForMessage() {
  return vi.mocked(generateGoatChatTitleForMessage);
}

function mockRunGoatBrainToolForUser() {
  return vi.mocked(runGoatBrainToolForUser);
}

function mockCaptureToGoatBrainInbox() {
  return vi.mocked(captureToGoatBrainInbox);
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
