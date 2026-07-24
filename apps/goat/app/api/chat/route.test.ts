import { convertToModelMessages, streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { executeGoatAction } from "@/lib/actions/execute";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import {
  activateAndListGoatChatSessionSkills,
  GoatBrainSkillMentionError,
  resolveGoatBrainSkillMentions,
} from "@/lib/brain-skills";
import { createGoatChatUserTurn, persistGoatChatAssistantMessage } from "@/lib/chat";
import { OPENCOMPANY_CHAT_MAX_STEPS } from "@/lib/chat-agent";
import { resolveGoatChatRequestContext } from "@/lib/chat-request-auth";
import { generateGoatChatTitleForMessage } from "@/lib/chat-title";
import {
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  GOAT_BRAIN_TOOL_NAME,
  GOAT_BRAIN_TOOL_PART_TYPE,
  LIST_ACTIONS_TOOL_NAME,
  LIST_ACTIONS_TOOL_PART_TYPE,
  SAVE_TO_BRAIN_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  START_TASK_TOOL_NAME,
  USE_ACTION_TOOL_NAME,
} from "@/lib/chat-ui";
import { GOAT_CHAT_PROMPT_MAX_LENGTH } from "@/lib/chat-validation";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import {
  deleteGoatTaskScheduleForUser,
  listGoatTaskSchedulesForUser,
  updateGoatTaskScheduleForUser,
} from "@/lib/task-schedules";
import { createGoatTaskForUser } from "@/lib/tasks";
import { POST } from "./route";

vi.mock("@/lib/chat-request-auth", () => ({
  resolveGoatChatRequestContext: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/brain-cli", () => ({
  runGoatBrainToolForUser: vi.fn(),
}));

vi.mock("@/lib/brain-capture", () => ({
  captureToGoatBrainInbox: vi.fn(),
}));

vi.mock("@/lib/brain-skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brain-skills")>();
  return {
    ...actual,
    activateAndListGoatChatSessionSkills: vi.fn(),
    resolveGoatBrainSkillMentions: vi.fn(),
  };
});

vi.mock("@/lib/chat", () => ({
  createDbGoatChatStore: vi.fn(() => ({})),
  createGoatChatApprovalContinuationTurn: vi.fn(),
  createGoatChatUserTurn: vi.fn(),
  dismissStaleGoatChatApprovals: vi.fn(async () => ({ changed: false, messages: [] })),
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
  deleteGoatTaskScheduleForUser: vi.fn(),
  listGoatTaskSchedulesForUser: vi.fn(),
  updateGoatTaskScheduleForUser: vi.fn(),
}));

vi.mock("@/lib/actions/catalog", () => ({
  isGoatChatActionsKilled: vi.fn(),
  resolveGoatActionCatalog: vi.fn(),
}));

vi.mock("@/lib/actions/execute", () => ({
  executeGoatAction: vi.fn(),
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
    mockListGoatTaskSchedulesForUser().mockResolvedValue([]);
    mockIsGoatCodexConnectedForUser().mockResolvedValue(false);
    mockIsGoatChatActionsKilled().mockReturnValue(false);
    mockResolveGoatActionCatalog().mockResolvedValue({ providers: [], actions: [] });
    vi.mocked(resolveGoatBrainSkillMentions).mockResolvedValue([]);
    vi.mocked(activateAndListGoatChatSessionSkills).mockResolvedValue([]);
  });

  it("rejects unauthenticated requests", async () => {
    mockResolveGoatChatRequestContext().mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

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

  it("resolves the action catalog for every non-engine request without a beta flag", async () => {
    mockAuth();
    mockCreateTurn();
    mockResolveGoatActionCatalog().mockResolvedValue(sampleActionCatalog());
    mockStreamText().mockImplementation((options: unknown) => {
      const streamOptions = options as {
        tools?: Record<string, unknown>;
        experimental_repairToolCall?: unknown;
      };
      const tools = streamOptions.tools ?? {};
      expect(tools[LIST_ACTIONS_TOOL_NAME]).toBeDefined();
      expect(tools[USE_ACTION_TOOL_NAME]).toBeDefined();
      expect(streamOptions.experimental_repairToolCall).toBeTypeOf("function");
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(validChatRequest("What's new in #general?"));
    expect(response.status).toBe(200);
    expect(resolveGoatActionCatalog).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "goat_ws_user_1",
    });
  });

  it("honors the actions kill switch", async () => {
    mockAuth();
    mockIsGoatChatActionsKilled().mockReturnValue(true);
    mockCreateTurn();
    mockStreamText().mockImplementation((options: unknown) => {
      const tools = (options as { tools?: Record<string, unknown> }).tools ?? {};
      expect(tools[LIST_ACTIONS_TOOL_NAME]).toBeUndefined();
      expect(tools[USE_ACTION_TOOL_NAME]).toBeUndefined();
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(validChatRequest("What's new in #general?"));
    expect(response.status).toBe(200);
    expect(resolveGoatActionCatalog).not.toHaveBeenCalled();
  });

  it("forwards use_action calls to the executor and returns its result", async () => {
    mockAuth({ timezone: "" });
    mockCreateTurn();
    mockPersistGoatChatAssistantMessage().mockResolvedValue({} as never);
    const catalog = sampleActionCatalog();
    mockResolveGoatActionCatalog().mockResolvedValue(catalog);
    mockExecuteGoatAction().mockResolvedValue({
      ok: true,
      action: "slack.fetch_history",
      result: { messages: [{ ts: "1.0", text: "hello" }] },
    });
    let actionOutput: unknown;
    mockStreamText().mockImplementation((options: unknown) => {
      const tools = (options as { tools?: Record<string, { execute?: unknown }> }).tools ?? {};
      const listActionsTool = tools[LIST_ACTIONS_TOOL_NAME];
      const actionTool = tools[USE_ACTION_TOOL_NAME];
      const executeListActions = listActionsTool?.execute;
      const executeAction = actionTool?.execute;
      if (typeof executeListActions !== "function") {
        throw new Error("list_actions was not configured.");
      }
      if (typeof executeAction !== "function") {
        throw new Error("use_action was not configured.");
      }
      const execution = Promise.resolve(
        executeListActions({ source: "slack" }, { toolCallId: "list_action_call_1", messages: [] }),
      ).then(() =>
        executeAction(
          { action: "slack.fetch_history", params: { channel: "C123" } },
          { toolCallId: "action_call_1", messages: [] },
        ),
      );
      return {
        toUIMessageStreamResponse: vi.fn(
          async (responseOptions: {
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
            actionOutput = await execution;
            await responseOptions.onFinish({
              responseMessage: {
                id: "assistant_1",
                role: "assistant",
                parts: [{ type: "text", text: "The latest message is hello." }],
              },
              finishReason: "stop",
              isAborted: false,
            });
            return new Response(null, { status: 200 });
          },
        ),
      } as never;
    });

    const response = await POST(validChatRequest("What's new in #general?"));
    expect(response.status).toBe(200);
    expect(executeGoatAction).toHaveBeenCalledWith(
      expect.objectContaining({
        catalog,
        actionId: "slack.fetch_history",
        params: { channel: "C123" },
        userWorkosId: "user_1",
        userTimezone: "UTC",
      }),
    );
    expect(actionOutput).toEqual(
      expect.objectContaining({ ok: true, action: "slack.fetch_history" }),
    );
    expect(persistGoatChatAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The latest message is hello.",
      }),
      expect.anything(),
    );
  });

  it("reuses successful action discovery from an earlier turn", async () => {
    mockAuth();
    mockCreateGoatChatUserTurn().mockResolvedValue({
      session: {
        id: "session_1",
        model: "openai/gpt-5.5",
      },
      sessionCreated: false,
      userMessage: {
        id: "user_message_2",
      },
      storedMessages: [],
      messages: [
        {
          id: "assistant_previous",
          role: "assistant",
          parts: [
            {
              type: LIST_ACTIONS_TOOL_PART_TYPE,
              toolCallId: "list_slack_previous",
              state: "output-available",
              input: { source: "slack" },
              output: {
                ok: true,
                source: {
                  id: "slack",
                  label: "Slack workspace",
                  description: "Read Slack messages.",
                },
                actions: [],
              },
            },
          ],
        },
      ],
    });
    const catalog = sampleActionCatalog();
    mockResolveGoatActionCatalog().mockResolvedValue(catalog);
    mockExecuteGoatAction().mockResolvedValue({
      ok: true,
      action: "slack.fetch_history",
      result: { messages: [] },
    });
    let execution: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const actionTool = (
        options as {
          tools?: Record<string, { execute?: unknown }>;
        }
      ).tools?.[USE_ACTION_TOOL_NAME];
      if (typeof actionTool?.execute !== "function") {
        throw new Error("use_action was not configured.");
      }
      execution = Promise.resolve(
        actionTool.execute(
          { action: "slack.fetch_history", params: { channel: "C123" } },
          { toolCallId: "action_call_2", messages: [] },
        ),
      );
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(validChatRequest("Now read #general."));
    expect(response.status).toBe(200);
    await expect(execution).resolves.toMatchObject({
      ok: true,
      action: "slack.fetch_history",
    });
    expect(executeGoatAction).toHaveBeenCalledTimes(1);
  });

  it("forces an approved continuation through use_action with its bound run id", async () => {
    mockAuth();
    mockCreateTurn();
    const catalog = {
      providers: [
        {
          id: "x" as const,
          kind: "managed" as const,
          label: "X",
          description: "Search public X data.",
        },
      ],
      actions: [
        {
          id: "x.search_posts",
          provider: "x" as const,
          capability: "read" as const,
          description: "Search X posts.",
          params: { type: "object" as const, properties: {} },
          permissionMode: "on" as const,
          execute: vi.fn(),
        },
      ],
    };
    mockResolveGoatActionCatalog().mockResolvedValue(catalog);
    mockExecuteGoatAction().mockResolvedValue({
      ok: true,
      action: "x.search_posts",
      result: { untrustedProviderData: true, resultCount: 1 },
    });
    let execution: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const settings = options as {
        system?: string;
        prepareStep?: (input: { stepNumber: number }) => unknown;
        tools?: Record<string, { execute?: unknown }>;
      };
      expect(settings.system).toContain("<action_sources>");
      expect(settings.system).not.toContain("<brain_fill>");
      expect(settings.prepareStep?.({ stepNumber: 0 })).toEqual({
        activeTools: [USE_ACTION_TOOL_NAME],
        toolChoice: { type: "tool", toolName: USE_ACTION_TOOL_NAME },
      });
      expect(settings.prepareStep?.({ stepNumber: OPENCOMPANY_CHAT_MAX_STEPS - 1 })).toEqual({
        activeTools: [],
        toolChoice: "none",
      });
      const actionTool = settings.tools?.[USE_ACTION_TOOL_NAME];
      if (typeof actionTool?.execute !== "function") {
        throw new Error("use_action was not configured.");
      }
      execution = actionTool.execute(
        { action: "x.search_posts", params: { query: "goat" } },
        { toolCallId: "approval_call_1", messages: [] },
      ) as Promise<unknown>;
      return {
        toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
      } as never;
    });

    const response = await POST(
      jsonRequest({
        sessionId: "session_1",
        model: "openai/gpt-5.5",
        capabilityApproval: {
          runId: "gcr_abc123",
          action: "x.search_posts",
          params: { query: "goat" },
        },
        message: {
          id: "ui_user_approval",
          role: "user",
          parts: [
            {
              type: "text",
              text: 'Continue x.search_posts with {"query":"goat"}',
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(200);
    await execution;
    expect(executeGoatAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "x.search_posts",
        params: { query: "goat" },
        workspaceId: "goat_ws_user_1",
        chatSessionId: "session_1",
        toolCallId: "approval_call_1",
        capabilityApprovalRunId: "gcr_abc123",
        capabilityTurnState: {
          quotedTotalUsdMicros: 0,
          asyncRunStarted: false,
        },
      }),
    );
  });

  it("forwards a valid browser-reserved id to new chat persistence", async () => {
    mockAuth();
    mockCreateTurn();
    mockStreamText().mockReturnValue({
      toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
    } as never);
    const newSessionId = "goat_chat_123e4567-e89b-42d3-a456-426614174000";

    const response = await POST(
      jsonRequest({
        newSessionId,
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "Start immediately" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateGoatChatUserTurn()).toHaveBeenCalledWith(
      expect.objectContaining({ newSessionId }),
      expect.anything(),
    );
  });

  it("rejects an invalid browser-reserved id", async () => {
    mockAuth();

    const response = await POST(
      jsonRequest({
        newSessionId: "goat_chat_invalid",
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_1",
          role: "user",
          parts: [{ type: "text", text: "Start" }],
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid new chat session id.");
    expect(mockCreateGoatChatUserTurn()).not.toHaveBeenCalled();
  });

  it("activates a selected skill on its message while preserving stored content", async () => {
    mockAuth();
    vi.mocked(resolveGoatBrainSkillMentions).mockResolvedValue([
      {
        id: "coding-work",
        name: "Coding work",
        description: "How coding work should happen.",
        instructions: "Inspect, implement, and verify.",
      },
    ]);
    mockCreateGoatChatUserTurn().mockResolvedValue({
      session: { id: "session_1", model: "openai/gpt-5.5" },
      userMessage: { id: "user_message_2" },
      storedMessages: [],
      messages: [
        { id: "user_message_1", role: "user", parts: [{ type: "text", text: "Earlier" }] },
        { id: "assistant_1", role: "assistant", parts: [{ type: "text", text: "Answer" }] },
        {
          id: "user_message_2",
          role: "user",
          parts: [{ type: "text", text: "Implement this" }],
        },
      ],
    } as never);
    vi.mocked(activateAndListGoatChatSessionSkills).mockResolvedValue([
      {
        chatSessionId: "session_1",
        skillId: "coding-work",
        brainRef: "goat_brain_user_1",
        activatedMessageId: "user_message_2",
        name: "Coding work",
        description: "How coding work should happen.",
        instructions: "Inspect, implement, and verify.",
        createdAt: new Date("2026-07-17T00:00:00Z"),
      },
    ]);
    mockStreamText().mockReturnValue({
      toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
    } as never);

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_2",
          role: "user",
          parts: [{ type: "text", text: "Implement this" }],
          metadata: {
            mentions: [{ kind: "skill", brainRef: "goat_brain_user_1", id: "coding-work" }],
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateGoatChatUserTurn()).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Implement this" }),
      expect.anything(),
    );
    expect(activateAndListGoatChatSessionSkills).toHaveBeenCalledWith({
      chatSessionId: "session_1",
      activatedMessageId: "user_message_2",
      brainRef: "goat_brain_user_1",
      skills: [expect.objectContaining({ id: "coding-work" })],
    });
    const modelUiMessages = vi.mocked(convertToModelMessages).mock
      .calls[0]?.[0] as unknown as Array<{
      parts: Array<{ type: string; text?: string }>;
    }>;
    expect(modelUiMessages[0]?.parts[0]?.text).toBe("Earlier");
    expect(modelUiMessages[2]?.parts[0]?.text).toContain(
      '"instructions":"Inspect, implement, and verify."',
    );
    expect(modelUiMessages[2]?.parts[0]?.text).toContain('"userRequest":"Implement this"');
  });

  it("replays an activated skill from its original message on later turns", async () => {
    mockAuth();
    mockCreateGoatChatUserTurn().mockResolvedValue({
      session: { id: "session_1", model: "openai/gpt-5.5" },
      userMessage: { id: "user_message_2" },
      storedMessages: [],
      messages: [
        {
          id: "user_message_1",
          role: "user",
          parts: [{ type: "text", text: "@skill/coding-work Implement this" }],
        },
        { id: "assistant_1", role: "assistant", parts: [{ type: "text", text: "Done" }] },
        {
          id: "user_message_2",
          role: "user",
          parts: [{ type: "text", text: "Now refine it" }],
        },
      ],
    } as never);
    vi.mocked(activateAndListGoatChatSessionSkills).mockResolvedValue([
      {
        chatSessionId: "session_1",
        skillId: "coding-work",
        brainRef: "goat_brain_user_1",
        activatedMessageId: "user_message_1",
        name: "Coding work",
        description: "How coding work should happen.",
        instructions: "Inspect, implement, and verify.",
        createdAt: new Date("2026-07-17T00:00:00Z"),
      },
    ]);
    mockStreamText().mockReturnValue({
      toUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
    } as never);

    const response = await POST(
      jsonRequest({
        sessionId: "session_1",
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_2",
          role: "user",
          parts: [{ type: "text", text: "Now refine it" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    const modelUiMessages = vi.mocked(convertToModelMessages).mock
      .calls[0]?.[0] as unknown as Array<{ parts: Array<{ type: string; text?: string }> }>;
    expect(modelUiMessages[0]?.parts[0]?.text).toContain(
      '"instructions":"Inspect, implement, and verify."',
    );
    expect(modelUiMessages[2]?.parts[0]?.text).toBe("Now refine it");
  });

  it("rejects stale structured skill references before storing the turn", async () => {
    mockAuth();
    vi.mocked(resolveGoatBrainSkillMentions).mockRejectedValue(
      new GoatBrainSkillMentionError("Skill is unavailable."),
    );

    const response = await POST(
      jsonRequest({
        model: "openai/gpt-5.5",
        message: {
          id: "ui_user_stale",
          role: "user",
          parts: [{ type: "text", text: "Implement this" }],
          metadata: {
            mentions: [{ kind: "skill", brainRef: "goat_brain_user_1", id: "missing" }],
          },
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Skill is unavailable.");
    expect(mockCreateGoatChatUserTurn()).not.toHaveBeenCalled();
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
        sourceRef: "linear:issue:ENG-1",
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
      sourceRef: "linear:issue:ENG-1",
      source: {
        kind: "chat",
        connectionId: "session_1",
        itemId: "user_message_1",
      },
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

  it("lets members capture through save_to_brain while keeping direct writes and tasks disabled", async () => {
    mockAuth({ role: "member" });
    mockCreateTurn();
    mockCaptureToGoatBrainInbox().mockResolvedValue({
      ok: true,
      draftBrainId: "member-note",
      path: "inbox/member-note.md",
      title: "Member note",
      jobId: "goat_brain_ingest_job_member",
      enqueued: true,
    });
    let brainToolPromise: Promise<unknown> | null = null;
    let saveToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        tools?: Record<string, { inputSchema?: unknown; execute?: unknown }>;
      };
      expect(typedOptions.system).not.toContain("browse-only access");
      expect(typedOptions.system).toContain("save_to_brain");
      expect(typedOptions.system).not.toContain("Start a task when the user asks");
      const saveTool = typedOptions.tools?.[SAVE_TO_BRAIN_TOOL_NAME];
      expect(saveTool).toBeDefined();
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
      if (typeof saveTool?.execute !== "function") {
        throw new Error("save_to_brain execute function was not configured.");
      }
      saveToolPromise = saveTool.execute({
        sourceRef: "gmail:thread:thread_1",
        integrationId: "gint_gmail_1",
        fallbackContent: "Customer context from the thread.",
        title: "Member note",
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
    await expect(saveToolPromise).resolves.toEqual({
      ok: true,
      draftId: "member-note",
      path: "inbox/member-note.md",
      title: "Member note",
      status: "captured",
    });
    expect(runGoatBrainToolForUser).not.toHaveBeenCalled();
    expect(captureToGoatBrainInbox).toHaveBeenCalledWith({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      sourceRef: "gmail:thread:thread_1",
      integrationId: "gint_gmail_1",
      fallbackText: "Customer context from the thread.",
      title: "Member note",
      source: {
        kind: "chat",
        connectionId: "session_1",
        itemId: "user_message_1",
      },
    });
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
    expect(listGoatTaskSchedulesForUser).not.toHaveBeenCalled();
  });

  it("keeps background task and schedule behavior out of chat when the user has not opted in", async () => {
    mockAuth({ taskSpawningEnabled: false });
    mockCreateTurn();
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        tools?: Record<string, unknown>;
      };
      expect(typedOptions.system).not.toContain("The rest of the app is organized around tasks");
      expect(typedOptions.system).not.toContain("Current recurring schedules");
      expect(typedOptions.system).not.toContain("Start a task when the user asks");
      expect(typedOptions.system).not.toMatch(/\btask(?:s)?\b|Results|routines/i);
      expect(typedOptions.tools?.[GOAT_BRAIN_TOOL_NAME]).toBeDefined();
      expect(typedOptions.tools?.[START_TASK_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[SCHEDULE_TASK_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[EDIT_TASK_SCHEDULE_TOOL_NAME]).toBeUndefined();
      expect(typedOptions.tools?.[DELETE_TASK_SCHEDULE_TOOL_NAME]).toBeUndefined();
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
          parts: [{ type: "text", text: "Research competitors" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(listGoatTaskSchedulesForUser).not.toHaveBeenCalled();
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
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

  it("wires Exa-backed web_fetch into the model stream when configured", async () => {
    vi.stubEnv("EXA_API_KEY", "exa_test");
    mockAuth();
    mockCreateTurn();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: "exa_contents_123",
            costDollars: { total: 0.001 },
            results: [
              {
                title: "Example article",
                url: "https://example.com/article",
                author: "Ada Lovelace",
                publishedDate: "2026-07-03",
                text: "This is the readable article.",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let webFetchToolPromise: Promise<unknown> | null = null;
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        tools?: { web_fetch?: { execute?: unknown } };
      };
      expect(typedOptions.system).toContain("Use web_fetch when the user provides a public URL");
      expect(typedOptions.system).toContain(
        "use web_search instead only when a page must be discovered",
      );
      const tool = typedOptions.tools?.web_fetch;
      if (typeof tool?.execute !== "function") {
        throw new Error("web_fetch execute function was not configured.");
      }
      webFetchToolPromise = tool.execute({
        url: "https://example.com/article#intro",
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
          parts: [{ type: "text", text: "https://example.com/article#intro" }],
        },
      }),
    );
    const output = await webFetchToolPromise;
    const [, fetchInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(response.status).toBe(200);
    expect(output).toEqual({
      ok: true,
      url: "https://example.com/article",
      title: "Example article",
      author: "Ada Lovelace",
      publishedDate: "2026-07-03",
      text: "This is the readable article.",
      requestId: "exa_contents_123",
      costUsdMicros: 1000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.exa.ai/contents",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "exa_test",
        },
      }),
    );
    expect(JSON.parse(String(fetchInit.body))).toEqual({
      urls: ["https://example.com/article"],
      text: { maxCharacters: 20_000 },
      maxAgeHours: 24,
      livecrawlTimeout: 15_000,
    });
  });

  it("omits public-web tools when EXA_API_KEY is absent", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    mockAuth();
    mockCreateTurn();
    mockStreamText().mockImplementation((options: unknown) => {
      const typedOptions = options as {
        system?: string;
        stopWhen?: unknown;
        prepareStep?: (input: { stepNumber: number }) => unknown;
        tools?: { web_fetch?: unknown; web_search?: unknown };
      };
      expect(typedOptions.stopWhen).toEqual({ count: OPENCOMPANY_CHAT_MAX_STEPS });
      expect(typedOptions.prepareStep?.({ stepNumber: OPENCOMPANY_CHAT_MAX_STEPS - 1 })).toEqual({
        activeTools: [],
        toolChoice: "none",
      });
      expect(typedOptions.tools?.web_fetch).toBeUndefined();
      expect(typedOptions.tools?.web_search).toBeUndefined();
      expect(typedOptions.system).not.toContain("Use web_fetch when the user provides");
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
    mockListGoatTaskSchedulesForUser().mockResolvedValue([
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
    mockUpdateGoatTaskScheduleForUser().mockResolvedValue({
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
    expect(updateGoatTaskScheduleForUser).toHaveBeenCalledWith("user_1", "goat_task_schedule_1", {
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
    mockListGoatTaskSchedulesForUser().mockResolvedValue([
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
    mockDeleteGoatTaskScheduleForUser().mockResolvedValue({ ok: true });
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
    expect(deleteGoatTaskScheduleForUser).toHaveBeenCalledWith("user_1", "goat_task_schedule_1");
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
    taskSpawningEnabled: boolean;
    role: "admin" | "member";
  }> = {},
) {
  const user = {
    email: overrides.email ?? "user@example.com",
    firstName: overrides.firstName ?? null,
    lastName: overrides.lastName ?? null,
    timezone: overrides.timezone ?? "UTC",
  };

  mockResolveGoatChatRequestContext().mockResolvedValue({
    ok: true,
    context: {
      user: {
        workosUserId: "user_1",
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: null,
        timezone: user.timezone,
        taskSpawningEnabled: overrides.taskSpawningEnabled ?? true,
        localCodexBetaEnabled: false,
        chatCapabilitiesBetaEnabled: false,
        onboardedAt: new Date(),
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
    },
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

function mockResolveGoatChatRequestContext() {
  return vi.mocked(resolveGoatChatRequestContext as unknown as () => Promise<unknown>);
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

function mockListGoatTaskSchedulesForUser() {
  return vi.mocked(listGoatTaskSchedulesForUser);
}

function mockUpdateGoatTaskScheduleForUser() {
  return vi.mocked(updateGoatTaskScheduleForUser);
}

function mockDeleteGoatTaskScheduleForUser() {
  return vi.mocked(deleteGoatTaskScheduleForUser);
}

function mockStreamText() {
  return vi.mocked(streamText);
}

function mockResolveGoatActionCatalog() {
  return vi.mocked(resolveGoatActionCatalog);
}

function mockIsGoatChatActionsKilled() {
  return vi.mocked(isGoatChatActionsKilled);
}

function mockExecuteGoatAction() {
  return vi.mocked(executeGoatAction);
}

function sampleActionCatalog() {
  return {
    providers: [
      {
        id: "slack" as const,
        label: 'Slack workspace "Acme"',
        description: "Read conversations, messages, threads, and workspace members.",
      },
    ],
    actions: [
      {
        id: "slack.fetch_history",
        provider: "slack" as const,
        capability: "read" as const,
        permissionMode: "on" as const,
        description: "Fetch recent messages from one Slack conversation.",
        params: { type: "object" as const, properties: {} },
        execute: vi.fn(),
      },
    ],
  };
}

function validChatRequest(text: string) {
  return jsonRequest({
    model: "openai/gpt-5.5",
    message: {
      id: "ui_user_1",
      role: "user",
      parts: [{ type: "text", text }],
    },
  });
}
