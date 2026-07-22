import { describe, expect, it, vi } from "vitest";
import {
  createOpenCompanyChatToolContext,
  MAX_ACTION_CALLS_PER_TURN,
  runOpenCompanyChatAgent,
} from "@/lib/chat-agent";
import {
  GOAT_BRAIN_TOOL_NAME,
  type GoatChatActionCatalog,
  type GoatBrainToolInput,
  LIST_ACTIONS_TOOL_NAME,
  type ListActionsToolInput,
  type ListActionsToolOutput,
  SAVE_TO_BRAIN_TOOL_NAME,
  type SaveToBrainToolInput,
  type SaveToBrainToolOutput,
  START_TASK_TOOL_NAME,
  USE_ACTION_TOOL_NAME,
  type UseActionToolInput,
  type UseActionToolOutput,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import {
  OPENCOMPANY_CHAT_SOUL,
  OPENCOMPANY_CHAT_SYSTEM,
  START_TASK_PROMPT_DESCRIPTION,
} from "@/lib/prompts";

describe("runOpenCompanyChatAgent", () => {
  it("instructs the model to delegate latest-email checks", async () => {
    const startTask = vi.fn();

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "check my latest emails" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        const system = extractSystemPrompt(options);
        expect(system).toContain(OPENCOMPANY_CHAT_SYSTEM);
        expect(system).toContain("You are OpenCompany");
        expect(system).toContain("Current date:");
        expect(system).toContain("Decide from the user's intent");
        expect(system).not.toContain("Use the web_search tool inside chat");
        expect(system).toContain("still call the task tool instead of refusing");
        expect(system).toContain("keep the task prompt close to the user's actual request");
        expect(system).toContain("Do not expand it into a detailed plan");
        expect(system).toContain("inbox");
        expect(system).toContain("Gmail");
        expect(system).toContain("goat_brain");
        expect(system).toContain(
          "The chat UI attaches compact citation chips for the main Brain wiki pages",
        );
        expect(system).toContain("not the underlying evidence");
        expect(system).toContain(OPENCOMPANY_CHAT_SOUL);
        expect(system).toContain("founder-focused operator");
        expect(extractStartTaskToolDescription(options)).toContain(
          "specialized just-in-time agent",
        );
        expect(START_TASK_PROMPT_DESCRIPTION).toContain(
          "Use the user's own request as the backbone",
        );
        expect(START_TASK_PROMPT_DESCRIPTION).toContain("Do not expand into a detailed plan");
        return {
          text: "I'll start a task for that.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
  });

  it("injects DB-backed user context into the system prompt", async () => {
    const startTask = vi.fn();

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "what should I do today?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      userContext: {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        timezone: "Europe/London",
      },
      generateTextImpl: (async (options: unknown) => {
        const system = extractSystemPrompt(options);
        expect(system).toContain("<user_context>");
        expect(system).toContain("compact user.md-style profile from the database");
        expect(system).toContain('firstName="Ada"');
        expect(system).toContain('lastName="Lovelace"');
        expect(system).toContain('email="ada@example.com"');
        expect(system).toContain('timezone="Europe/London"');
        return {
          text: "Start with the highest-leverage item.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });
  });

  it("returns a normal assistant message without creating a task", async () => {
    const startTask = vi.fn();

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "what do you think of x?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        expect(extractLastUserMessage(options)).toBe("what do you think of x?");
        return {
          text: "x has tradeoffs, but the direction seems reasonable.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(result.task).toBeNull();
    expect(result.content).toBe("x has tradeoffs, but the direction seems reasonable.");
  });

  it("creates one queued task when the agent calls start_task", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Market research for x",
      prompt: task.prompt,
    }));

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "research the market for x" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        const toolResult = await executeStartTaskTool(options, {
          name: "Market research for x",
          prompt: "Research the market for x and summarize the strongest signals.",
          reason: "Requires research and should be tracked.",
        });

        return {
          text: "I started a task and added it to Results.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: START_TASK_TOOL_NAME }],
              toolResults: [toolResult],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith({
      name: "Market research for x",
      prompt: "Research the market for x and summarize the strongest signals.",
      model: DEFAULT_GOAT_MODEL,
    });
    expect(result.task).toEqual({
      id: "task_1",
      displayId: "TASK-1",
      name: "Market research for x",
      prompt: "Research the market for x and summarize the strongest signals.",
    });
    expect(result.content).toBe("I started a task and added it to Results.");
  });

  it("preserves Codex task intent from the original user turn when start_task rewrites the prompt", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Test repo access",
      prompt: task.prompt,
    }));

    await runOpenCompanyChatAgent({
      messages: [
        {
          role: "user",
          content:
            "try creating a new codex task that checks out opencompany-experimental and tests repo access",
        },
      ],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        await executeStartTaskTool(options, {
          name: "Test repo access",
          prompt:
            "Check out opencompany-experimental, verify the repository can be viewed, and report whether development work can start.",
          reason: "Requires connected source-control access.",
        });

        return {
          text: "I started a task and added it to Results.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).toHaveBeenCalledWith({
      name: "Test repo access",
      prompt:
        "Check out opencompany-experimental, verify the repository can be viewed, and report whether development work can start.",
      model: DEFAULT_GOAT_MODEL,
      engine: "codex",
    });
  });

  it("does not infer Codex steering from a manually typed @codex token", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Test repo access",
      prompt: task.prompt,
    }));

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "@codex check repo access" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        await executeStartTaskTool(options, {
          name: "Test repo access",
          prompt: "Check repo access and report whether development work can start.",
          reason: "Requires connected source-control access.",
        });

        return {
          text: "I started a task and added it to Results.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).toHaveBeenCalledWith({
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
      model: DEFAULT_GOAT_MODEL,
    });
  });

  it("uses structured requested Codex steering even when the prompt omits Codex", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Test repo access",
      prompt: task.prompt,
    }));

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "@codex check repo access" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      requestedEngine: "codex",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        await executeStartTaskTool(options, {
          name: "Test repo access",
          prompt: "Check repo access and report whether development work can start.",
          reason: "Requires connected source-control access.",
        });

        return {
          text: "I started a task and added it to Results.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(startTask).toHaveBeenCalledWith({
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
      model: DEFAULT_GOAT_MODEL,
      engine: "codex",
    });
  });

  it("deduplicates concurrent start_task tool calls", async () => {
    type TestStartedTask = {
      id: string;
      displayId: string;
      name: string;
      prompt: string;
    };
    let resolveTask: ((task: TestStartedTask) => void) | null = null;
    const startTask = vi.fn(
      (async () =>
        new Promise<TestStartedTask>((resolve) => {
          resolveTask = resolve;
        })) as never,
    );

    const resultPromise = runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "research the market for x" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      generateTextImpl: (async (options: unknown) => {
        const first = executeStartTaskTool(options, {
          name: "Market research for x",
          prompt: "Research the market for x and summarize the strongest signals.",
          reason: "Requires research and should be tracked.",
        });
        const second = executeStartTaskTool(options, {
          name: "Duplicate market research for x",
          prompt: "Do the same research again.",
          reason: "Parallel duplicate.",
        });
        expect(startTask).toHaveBeenCalledTimes(1);
        resolveTask?.({
          id: "task_1",
          displayId: "TASK-1",
          name: "Market research for x",
          prompt: "Research the market for x and summarize the strongest signals.",
        });
        const toolResults = await Promise.all([first, second]);

        return {
          text: "I started a task and added it to Results.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: START_TASK_TOOL_NAME }, { toolName: START_TASK_TOOL_NAME }],
              toolResults,
            },
          ],
        };
      }) as never,
    });

    const result = await resultPromise;

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(result.task?.id).toBe("task_1");
    expect(result.debugTrace.toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "queued" }),
        expect.objectContaining({ status: "already_started" }),
      ]),
    );
  });

  it("can call the personal brain CLI inside the chat loop", async () => {
    const startTask = vi.fn();
    const runBrainCli = vi.fn(async (input: GoatBrainToolInput) => ({
      ok: true,
      exitCode: 0,
      stdout: "1. [inbox] Hiring note (hiring-note, score 1, updated 2026-01-01T00:00:00.000Z)",
      stderr: "",
      input,
    }));

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "what did I say about hiring?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      runBrainCli,
      generateTextImpl: (async (options: unknown) => {
        expect(extractGoatBrainToolDescription(options)).toContain("Read-only");
        expect(extractGoatBrainToolDescription(options)).not.toContain("ingest");
        expect(extractGoatBrainToolDescription(options)).not.toContain("append-evidence");
        const commandEnum = extractGoatBrainCommandEnum(options);
        expect(commandEnum).toContain("query");
        expect(commandEnum).not.toContain("create");
        expect(commandEnum).not.toContain("append-evidence");
        expect(commandEnum).not.toContain("rewrite");
        expect(commandEnum).not.toContain("delete");
        const toolResult = await executeGoatBrainTool(options, {
          command: "query",
          flags: {
            text: "hiring",
            hops: 1,
            limit: 5,
            json: true,
          },
        });

        return {
          text: "Your Brain has a hiring note in inbox.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: GOAT_BRAIN_TOOL_NAME }],
              toolResults: [toolResult],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(runBrainCli).toHaveBeenCalledWith({
      command: "query",
      flags: {
        text: "hiring",
        hops: 1,
        limit: 5,
        json: true,
      },
    });
    expect(result.task).toBeNull();
    expect(result.content).toBe("Your Brain has a hiring note in inbox.");
    expect(result.debugTrace.toolResults).toHaveLength(1);
  });

  it("rejects every direct brain write from the chat loop", async () => {
    const startTask = vi.fn();
    const runBrainCli = vi.fn();

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "remember Acme is building billing tools" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      runBrainCli,
      generateTextImpl: (async (options: unknown) => {
        for (const command of [
          "create",
          "append-evidence",
          "rewrite",
          "set",
          "move",
          "merge",
          "link",
          "delete",
        ]) {
          await expect(
            executeGoatBrainTool(options, {
              command,
              flags: { id: "acme" },
            }),
          ).rejects.toThrow("goat_brain command is invalid");
        }

        return {
          text: "I need to save new Brain content through the inbox capture path.",
          finishReason: "stop",
          steps: [],
        };
      }) as never,
    });

    expect(runBrainCli).not.toHaveBeenCalled();
  });

  it("allows listing personal brain docs without semantic search", async () => {
    const startTask = vi.fn();
    const runBrainCli = vi.fn(async (input: GoatBrainToolInput) => ({
      ok: true,
      exitCode: 0,
      stdout: "[projects] Launch plan (launch-plan, updated 2026-01-01T00:00:00.000Z)",
      stderr: "",
      input,
    }));

    await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "show me everything in my brain" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      runBrainCli,
      generateTextImpl: (async (options: unknown) => {
        expect(extractSystemPrompt(options)).toContain("list for inventory/enumeration");
        return {
          text: "You have one project note.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: GOAT_BRAIN_TOOL_NAME }],
              toolResults: [
                await executeGoatBrainTool(options, {
                  command: "list",
                  flags: { limit: 50, json: true },
                }),
              ],
            },
          ],
        };
      }) as never,
    });

    expect(runBrainCli).toHaveBeenCalledWith({
      command: "list",
      flags: { limit: 50, json: true },
    });
  });

  it("captures saves through save_to_brain and dedupes repeat calls in one turn", async () => {
    const startTask = vi.fn();
    const saveToBrain = vi.fn(
      async (input: SaveToBrainToolInput): Promise<SaveToBrainToolOutput> => ({
        ok: true,
        draftId: "pricing-teardown-reference",
        path: "inbox/pricing-teardown-reference.md",
        title: input.title ?? "Pricing teardown reference",
        status: "captured",
      }),
    );

    const result = await runOpenCompanyChatAgent({
      messages: [
        {
          role: "user",
          content: "save this reference: https://example.com/pricing-teardown",
        },
      ],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      saveToBrain,
      generateTextImpl: (async (options: unknown) => {
        const system = extractSystemPrompt(options);
        expect(system).toContain("save_to_brain");
        expect(system).toContain("draft in the Brain inbox");
        expect(system).toContain("an idea, a thought, a decision");
        expect(system).toContain(
          "remain notes, are filed under thoughts/concepts/projects/decisions",
        );
        const saveDescription = extractSaveToBrainToolDescription(options);
        expect(saveDescription).toContain("draft page in the inbox");
        expect(saveDescription).toContain("idea, thought, note");

        const first = await executeSaveToBrainTool(options, {
          content: "https://example.com/pricing-teardown",
          title: "Pricing teardown reference",
          intent: "reference for the pricing rework",
        });
        expect(first).toMatchObject({ ok: true, status: "captured" });

        const repeat = await executeSaveToBrainTool(options, {
          content: "https://example.com/pricing-teardown",
          title: "Pricing teardown reference",
        });
        expect(repeat).toMatchObject({ ok: true, status: "already_captured" });

        const empty = await executeSaveToBrainTool(options, { content: "   " });
        expect(empty).toMatchObject({ ok: false });

        return {
          text: "Saved. It's in your Brain inbox and will be filed shortly.",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: SAVE_TO_BRAIN_TOOL_NAME }],
              toolResults: [first],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(saveToBrain).toHaveBeenCalledTimes(1);
    expect(saveToBrain).toHaveBeenCalledWith({
      content: "https://example.com/pricing-teardown",
      title: "Pricing teardown reference",
      intent: "reference for the pricing rework",
    });
    expect(result.task).toBeNull();
    expect(result.content).toContain("Saved.");
  });

  it("can call web_search inside the chat loop without starting a task", async () => {
    const startTask = vi.fn();
    const webSearch = vi.fn(
      async (input: WebSearchToolInput): Promise<WebSearchToolOutput> => ({
        ok: true,
        query: input.query,
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
      }),
    );

    const result = await runOpenCompanyChatAgent({
      messages: [{ role: "user", content: "What are the latest updates on Google?" }],
      model: DEFAULT_GOAT_MODEL,
      gatewayApiKey: "test-key",
      startTask,
      webSearch,
      currentDate: "2026-07-04T12:00:00.000Z",
      generateTextImpl: (async (options: unknown) => {
        const system = extractSystemPrompt(options);
        expect(system).toContain("Current date: 2026-07-04.");
        expect(system).toContain("Use the web_search tool inside chat");
        expect(system).toContain("Start a task when the user asks for deep research");
        expect(extractWebSearchToolDescription(options)).toContain("one-shot");

        const firstToolResult = await executeWebSearchTool(options, {
          query: "latest Google updates",
          recencyDays: 30,
        });
        const cappedToolResult = await executeWebSearchTool(options, {
          query: "another Google update",
        });
        expect(cappedToolResult).toMatchObject({
          ok: false,
          error: expect.stringContaining("limited to one search"),
        });

        return {
          text: "Google shared a current product update.\n\nSources:\n- [Google Blog](https://blog.google)",
          finishReason: "stop",
          steps: [
            {
              toolCalls: [{ toolName: WEB_SEARCH_TOOL_NAME }],
              toolResults: [firstToolResult],
            },
          ],
        };
      }) as never,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(webSearch).toHaveBeenCalledWith({
      query: "latest Google updates",
      recencyDays: 30,
    });
    expect(result.task).toBeNull();
    expect(result.content).toContain("Sources:");
    expect(result.content).toContain("[Google Blog](https://blog.google)");
  });
});

describe("list_actions and use_action tools", () => {
  const catalog: GoatChatActionCatalog = {
    providers: [
      {
        id: "slack",
        label: 'Slack workspace "Acme"',
        description: "Read Slack messages.",
      },
      {
        id: "linear",
        label: "Linear workspace",
        description: "Read Linear records.",
      },
    ],
    actions: [
      {
        id: "slack.fetch_history",
        provider: "slack",
        description: "Fetch recent messages from one Slack conversation.",
        params: { type: "object", properties: { channel: { type: "string" } } },
      },
      {
        id: "linear.list_issues",
        provider: "linear",
        description: "List Linear issues.",
        params: { type: "object", properties: {} },
      },
    ],
  };
  const okResult = (action: string): UseActionToolOutput => ({
    ok: true,
    action,
    result: { messages: [] },
  });

  it("is absent without an action catalog", () => {
    const context = createOpenCompanyChatToolContext({
      model: DEFAULT_GOAT_MODEL,
      runBrainCli: vi.fn(),
    });
    expect(context.tools[LIST_ACTIONS_TOOL_NAME]).toBeUndefined();
    expect(context.tools[USE_ACTION_TOOL_NAME]).toBeUndefined();

    const emptyContext = createOpenCompanyChatToolContext({
      model: DEFAULT_GOAT_MODEL,
      runBrainCli: vi.fn(),
      actions: { catalog: { providers: [], actions: [] }, execute: vi.fn() },
    });
    expect(emptyContext.tools[LIST_ACTIONS_TOOL_NAME]).toBeUndefined();
    expect(emptyContext.tools[USE_ACTION_TOOL_NAME]).toBeUndefined();
  });

  it("builds integration and action enums and lists only the selected integration", async () => {
    const context = createOpenCompanyChatToolContext({
      model: DEFAULT_GOAT_MODEL,
      runBrainCli: vi.fn(),
      actions: { catalog, execute: vi.fn() },
    });
    expect(extractListActionsIntegrationEnum(context.tools)).toEqual(["slack", "linear"]);
    expect(extractUseActionEnum(context.tools)).toEqual([
      "slack.fetch_history",
      "linear.list_issues",
    ]);
    const listed = await executeListActionsTool(context.tools, { integration: "slack" });
    expect(listed).toEqual({
      ok: true,
      integration: catalog.providers[0],
      actions: [catalog.actions[0]],
    });

    const listedLinear = await executeListActionsTool(context.tools, { integration: "linear" });
    expect(listedLinear).toEqual({
      ok: true,
      integration: catalog.providers[1],
      actions: [catalog.actions[1]],
    });

    const unknown = await executeListActionsTool(context.tools, {
      integration: "mail",
    } as unknown as ListActionsToolInput);
    expect(unknown).toEqual({
      ok: false,
      error: {
        code: "unknown_integration",
        message: 'Unknown integration "mail". Use an exact id from <integrations>.',
        availableIntegrations: ["slack", "linear"],
      },
    });
  });

  it("dispatches valid calls and steers invalid or over-budget ones", async () => {
    const execute = vi.fn(async ({ action }: { action: string }) => okResult(action));
    const context = createOpenCompanyChatToolContext({
      model: DEFAULT_GOAT_MODEL,
      runBrainCli: vi.fn(),
      actions: { catalog, execute },
    });

    const valid = await executeUseActionTool(context.tools, {
      action: "slack.fetch_history",
      params: { channel: "C123" },
    });
    expect(valid.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "slack.fetch_history",
        params: { channel: "C123" },
      }),
    );

    const unknown = await executeUseActionTool(context.tools, {
      action: "github.list_repos",
      params: {},
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("invalid_params");
      expect(unknown.error.message).toContain("list_actions");
    }
    expect(execute).toHaveBeenCalledTimes(1);

    // Missing params coerces to an empty object rather than failing.
    await executeUseActionTool(context.tools, { action: "linear.list_issues" });
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "linear.list_issues", params: {} }),
    );

    for (let call = 2; call < MAX_ACTION_CALLS_PER_TURN; call += 1) {
      await executeUseActionTool(context.tools, {
        action: "slack.fetch_history",
        params: { channel: `C${call}` },
      });
    }
    const overBudget = await executeUseActionTool(context.tools, {
      action: "slack.fetch_history",
      params: { channel: "Cx" },
    });
    expect(overBudget.ok).toBe(false);
    if (!overBudget.ok) expect(overBudget.error.code).toBe("call_budget");
    expect(execute).toHaveBeenCalledTimes(MAX_ACTION_CALLS_PER_TURN);
  });
});

function extractSystemPrompt(options: unknown) {
  return (options as { system?: string }).system ?? "";
}

function extractStartTaskToolDescription(options: unknown) {
  type ToolOptions = {
    tools?: Record<typeof START_TASK_TOOL_NAME, { description?: string }>;
  };
  return (options as ToolOptions).tools?.[START_TASK_TOOL_NAME]?.description ?? "";
}

function extractGoatBrainToolDescription(options: unknown) {
  type ToolOptions = {
    tools?: Record<typeof GOAT_BRAIN_TOOL_NAME, { description?: string }>;
  };
  return (options as ToolOptions).tools?.[GOAT_BRAIN_TOOL_NAME]?.description ?? "";
}

function extractGoatBrainCommandEnum(options: unknown) {
  type CommandSchema = { properties?: { command?: { enum?: string[] } } };
  type ToolOptions = {
    tools?: Record<
      typeof GOAT_BRAIN_TOOL_NAME,
      { inputSchema?: CommandSchema & { jsonSchema?: CommandSchema } }
    >;
  };
  // The AI SDK jsonSchema() helper wraps the schema, so the enum can live at
  // inputSchema.properties or inputSchema.jsonSchema.properties.
  const inputSchema = (options as ToolOptions).tools?.[GOAT_BRAIN_TOOL_NAME]?.inputSchema;
  return (
    inputSchema?.properties?.command?.enum ??
    inputSchema?.jsonSchema?.properties?.command?.enum ??
    []
  );
}

function extractWebSearchToolDescription(options: unknown) {
  type ToolOptions = {
    tools?: Record<typeof WEB_SEARCH_TOOL_NAME, { description?: string }>;
  };
  return (options as ToolOptions).tools?.[WEB_SEARCH_TOOL_NAME]?.description ?? "";
}

function extractLastUserMessage(options: unknown) {
  const messages = (options as { messages?: Array<{ role: string; content: string }> }).messages;
  return messages?.filter((message) => message.role === "user").at(-1)?.content;
}

async function executeStartTaskTool(
  options: unknown,
  input: {
    prompt: string;
    name: string;
    reason: string;
    engine?: "opencompany" | "codex";
  },
) {
  type ToolOptions = {
    tools?: Record<typeof START_TASK_TOOL_NAME, { execute?: unknown }>;
  };
  const tool = (options as ToolOptions).tools?.[START_TASK_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${START_TASK_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}

async function executeGoatBrainTool(options: unknown, input: Record<string, unknown>) {
  type ToolOptions = {
    tools?: Record<typeof GOAT_BRAIN_TOOL_NAME, { execute?: unknown }>;
  };
  const tool = (options as ToolOptions).tools?.[GOAT_BRAIN_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${GOAT_BRAIN_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}

function extractSaveToBrainToolDescription(options: unknown) {
  type ToolOptions = {
    tools?: Record<typeof SAVE_TO_BRAIN_TOOL_NAME, { description?: string }>;
  };
  return (options as ToolOptions).tools?.[SAVE_TO_BRAIN_TOOL_NAME]?.description ?? "";
}

async function executeSaveToBrainTool(options: unknown, input: SaveToBrainToolInput) {
  type ToolOptions = {
    tools?: Record<typeof SAVE_TO_BRAIN_TOOL_NAME, { execute?: unknown }>;
  };
  const tool = (options as ToolOptions).tools?.[SAVE_TO_BRAIN_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${SAVE_TO_BRAIN_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}

async function executeWebSearchTool(options: unknown, input: WebSearchToolInput) {
  type ToolOptions = {
    tools?: Record<typeof WEB_SEARCH_TOOL_NAME, { execute?: unknown }>;
  };
  const tool = (options as ToolOptions).tools?.[WEB_SEARCH_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${WEB_SEARCH_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input);
}

function extractUseActionEnum(tools: unknown) {
  type ActionSchema = { properties?: { action?: { enum?: string[] } } };
  type Tools = Record<
    typeof USE_ACTION_TOOL_NAME,
    { inputSchema?: ActionSchema & { jsonSchema?: ActionSchema } }
  >;
  const inputSchema = (tools as Tools)[USE_ACTION_TOOL_NAME]?.inputSchema;
  return (
    inputSchema?.properties?.action?.enum ?? inputSchema?.jsonSchema?.properties?.action?.enum ?? []
  );
}

function extractListActionsIntegrationEnum(tools: unknown) {
  type IntegrationSchema = { properties?: { integration?: { enum?: string[] } } };
  type Tools = Record<
    typeof LIST_ACTIONS_TOOL_NAME,
    { inputSchema?: IntegrationSchema & { jsonSchema?: IntegrationSchema } }
  >;
  const inputSchema = (tools as Tools)[LIST_ACTIONS_TOOL_NAME]?.inputSchema;
  return (
    inputSchema?.properties?.integration?.enum ??
    inputSchema?.jsonSchema?.properties?.integration?.enum ??
    []
  );
}

async function executeListActionsTool(
  tools: unknown,
  input: ListActionsToolInput,
): Promise<ListActionsToolOutput> {
  type Tools = Record<typeof LIST_ACTIONS_TOOL_NAME, { execute?: unknown }>;
  const tool = (tools as Tools)[LIST_ACTIONS_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${LIST_ACTIONS_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input, { toolCallId: "call_0", messages: [] });
}

async function executeUseActionTool(
  tools: unknown,
  input: UseActionToolInput,
): Promise<UseActionToolOutput> {
  type Tools = Record<typeof USE_ACTION_TOOL_NAME, { execute?: unknown }>;
  const tool = (tools as Tools)[USE_ACTION_TOOL_NAME];
  if (typeof tool?.execute !== "function") {
    throw new Error(`${USE_ACTION_TOOL_NAME} execute function was not configured.`);
  }
  return tool.execute(input, { toolCallId: "call_1", messages: [] });
}
