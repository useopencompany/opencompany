import { describe, expect, it } from "vitest";
import type { CodexAppServerNormalizedEvent } from "./codex-app-server-events";
import { normalizeCodexAppServerEvent } from "./codex-app-server-events";
import {
  applyCodexEventToUiMessageParts,
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_PART_TYPE,
  CODEX_DYNAMIC_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_PART_TYPE,
  CODEX_WEB_SEARCH_TOOL_NAME,
  type CodexUiMessagePart,
  type CodexUiSubagentPart,
  codexUiMessagePartsContent,
  createCodexCommandOutputAccumulator,
  finalizeCodexUiMessageParts,
  offerCodexPlanImplementation,
  parseCodexUiMessageParts,
  resolveCodexUiInteraction,
} from "./codex-ui-message-parts";

function normalizedEvent(
  type: CodexAppServerNormalizedEvent["type"],
  payload: Record<string, unknown>,
): CodexAppServerNormalizedEvent {
  return { type, payload, rawEvent: {} };
}

function reduceNormalized(parts: CodexUiMessagePart[], raw: CodexAppServerNormalizedEvent[]) {
  let current = parts;
  for (const event of raw) {
    current = applyCodexEventToUiMessageParts(current, event).parts;
  }
  return current;
}

function events(raw: Record<string, unknown>[]) {
  return raw.flatMap((event) => normalizeCodexAppServerEvent(event));
}

function reduce(parts: CodexUiMessagePart[], raw: Record<string, unknown>[]) {
  let current = parts;
  for (const event of events(raw)) {
    current = applyCodexEventToUiMessageParts(current, event).parts;
  }
  return current;
}

describe("applyCodexEventToUiMessageParts", () => {
  it("projects an interleaved reasoning/command/text turn in order", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/completed",
          params: { item: { id: "r_1", type: "reasoning", text: "Considering the repo layout." } },
        },
        {
          method: "item/started",
          params: { item: { id: "cmd_1", type: "commandExecution", command: "ls apps" } },
        },
        {
          method: "item/completed",
          params: {
            item: {
              id: "cmd_1",
              type: "commandExecution",
              command: "ls apps",
              status: "completed",
              exitCode: 0,
            },
          },
        },
        {
          method: "item/completed",
          params: { item: { id: "msg_1", type: "agentMessage", text: "The repo has three apps." } },
        },
      ],
    );

    expect(parts).toEqual([
      { type: "reasoning", text: "Considering the repo layout.", state: "done" },
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_1",
        state: "output-available",
        input: { command: "ls apps" },
        output: { status: "completed", exitCode: 0 },
      },
      { type: "text", text: "The repo has three apps." },
    ]);
    expect(codexUiMessagePartsContent(parts)).toBe("The repo has three apps.");
  });

  it("keeps a started command in input-available state until it completes", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/started",
          params: { item: { id: "cmd_1", type: "commandExecution", command: "bun test" } },
        },
      ],
    );
    expect(parts).toEqual([
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_1",
        state: "input-available",
        input: { command: "bun test" },
      },
    ]);
  });

  it("matches command completion by itemId and marks failures as output-error", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/started",
          params: { item: { id: "cmd_1", type: "commandExecution", command: "one" } },
        },
        {
          method: "item/started",
          params: { item: { id: "cmd_2", type: "commandExecution", command: "two" } },
        },
        {
          method: "item/completed",
          params: {
            item: {
              id: "cmd_1",
              type: "commandExecution",
              command: "one",
              status: "failed",
              exitCode: 2,
              error: "boom",
            },
          },
        },
      ],
    );

    expect(parts[0]).toEqual({
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      toolCallId: "cmd_1",
      state: "output-error",
      input: { command: "one" },
      errorText: "boom",
    });
    expect(parts[1]).toMatchObject({ toolCallId: "cmd_2", state: "input-available" });
  });

  it("synthesizes a terminal command part when the started event was lost", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/completed",
          params: {
            item: {
              id: "cmd_9",
              type: "commandExecution",
              command: "make",
              status: "completed",
              exitCode: 0,
            },
          },
        },
      ],
    );
    expect(parts).toEqual([
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_9",
        state: "output-available",
        input: { command: "make" },
        output: { status: "completed", exitCode: 0 },
      },
    ]);
  });

  it("ignores duplicate command.started events for the same item", () => {
    const started = {
      method: "item/started",
      params: { item: { id: "cmd_1", type: "commandExecution", command: "pwd" } },
    };
    const parts = reduce([], [started, started]);
    expect(parts).toHaveLength(1);
  });

  it("treats deltas, turn events, and usage as no-ops", () => {
    for (const raw of [
      { method: "item/agentMessage/delta", params: { delta: "hel" } },
      { method: "turn/started", params: { turn: { id: "t1" } } },
      { method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } },
      { method: "thread/tokenUsage/updated", params: { tokenUsage: { total: 5 } } },
    ]) {
      const [event] = normalizeCodexAppServerEvent(raw);
      const projection = applyCodexEventToUiMessageParts([], event!);
      expect(projection.changed).toBe(false);
      expect(projection.parts).toEqual([]);
    }
  });

  it("surfaces error events without adding parts", () => {
    const [event] = normalizeCodexAppServerEvent({
      method: "error",
      params: { message: "rate limited" },
    });
    const projection = applyCodexEventToUiMessageParts([], event!);
    expect(projection.changed).toBe(true);
    expect(projection.error).toBe("rate limited");
    expect(projection.parts).toEqual([]);
  });

  it("attaches a truncated output preview on completion when provided", () => {
    const accumulator = createCodexCommandOutputAccumulator(10);
    for (const raw of [
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "cmd_1", delta: "0123456789" },
      },
      { method: "item/commandExecution/outputDelta", params: { itemId: "cmd_1", delta: "abcdef" } },
    ]) {
      for (const event of normalizeCodexAppServerEvent(raw)) accumulator.push(event);
    }

    const [completed] = normalizeCodexAppServerEvent({
      method: "item/completed",
      params: {
        item: {
          id: "cmd_1",
          type: "commandExecution",
          command: "cat file",
          status: "completed",
          exitCode: 0,
        },
      },
    });
    const projection = applyCodexEventToUiMessageParts([], completed!, {
      commandOutputPreview: accumulator.take("cmd_1"),
    });
    expect(projection.parts[0]).toMatchObject({
      state: "output-available",
      output: { status: "completed", exitCode: 0, outputPreview: "6789abcdef" },
    });
    expect(accumulator.take("cmd_1")).toBeNull();
  });

  it("projects plan deltas into a durable plan part", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/plan/delta",
          params: { itemId: "plan_1", delta: "1. Read code\n" },
        },
        {
          method: "item/plan/delta",
          params: { itemId: "plan_1", delta: "2. Patch tests" },
        },
        {
          method: "item/completed",
          params: {
            item: {
              id: "plan_1",
              type: "plan",
              text: "1. Read code\n2. Patch tests",
              status: "completed",
            },
          },
        },
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_PLAN_TOOL_NAME,
        toolCallId: "plan_1",
        state: "output-available",
        input: { label: "Plan" },
        output: { status: "completed", text: "1. Read code\n2. Patch tests" },
      },
    ]);

    const offered = offerCodexPlanImplementation(parts);
    expect(offered.changed).toBe(true);
    expect(offered.parts[0]).toMatchObject({
      output: { implementationAvailable: true },
    });
  });

  it("projects native turn plan updates without offering implementation", () => {
    const parts = reduce(
      [],
      [
        {
          method: "turn/plan/updated",
          params: {
            turnId: "turn_1",
            plan: [
              { step: "Inspect the renderer", status: "completed" },
              { step: "Patch native plan support", status: "inProgress" },
            ],
          },
        },
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_PLAN_TOOL_NAME,
        toolCallId: "turn-plan:turn_1",
        state: "input-available",
        input: {
          label: "Plan",
          source: "turn_plan",
          text: "[x] Inspect the renderer\n[~] Patch native plan support",
          plan: [
            { step: "Inspect the renderer", status: "completed" },
            { step: "Patch native plan support", status: "inProgress" },
          ],
        },
      },
    ]);

    const finalized = finalizeCodexUiMessageParts(parts, "completed").parts;
    expect(finalized[0]).toMatchObject({
      state: "output-available",
      output: {
        status: "completed",
        source: "turn_plan",
        text: "[x] Inspect the renderer\n[~] Patch native plan support",
      },
    });
    expect(offerCodexPlanImplementation(finalized).changed).toBe(false);
  });

  it("offers implementation only through the explicit terminal Plan-mode transition", () => {
    const noPlan = offerCodexPlanImplementation([{ type: "text", text: "Done" }]);
    expect(noPlan.changed).toBe(false);

    const runningPlan: CodexUiMessagePart[] = [
      {
        type: "dynamic-tool",
        toolName: CODEX_PLAN_TOOL_NAME,
        toolCallId: "plan_1",
        state: "input-available",
        input: { label: "Plan", text: "1. Inspect" },
      },
    ];
    expect(offerCodexPlanImplementation(runningPlan).changed).toBe(false);
  });

  it("projects and resolves an interactive app-server question", () => {
    const [event] = normalizeCodexAppServerEvent({
      id: 42,
      method: "item/tool/requestUserInput",
      interactionId: "interaction_1",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "question_1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How broad should the fix be?",
            options: [{ label: "Foundational", description: "Harden the full path." }],
          },
        ],
      },
    });
    const waiting = applyCodexEventToUiMessageParts([], event!).parts;
    expect(waiting[0]).toMatchObject({
      toolName: CODEX_QUESTION_TOOL_NAME,
      state: "approval-requested",
      input: {
        interactionId: "interaction_1",
        question: "How broad should the fix be?",
      },
    });

    const answered = resolveCodexUiInteraction(waiting, {
      interactionId: "interaction_1",
      status: "answered",
    });
    expect(answered.parts[0]).toMatchObject({
      state: "output-available",
      output: { status: "answered" },
    });
  });

  it("projects file changes, MCP tool calls, and web searches as durable parts", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/started",
          params: {
            item: { id: "file_1", type: "fileChange", changes: [{ path: "src/a.ts" }] },
          },
        },
        {
          method: "item/completed",
          params: {
            item: {
              id: "file_1",
              type: "fileChange",
              status: "completed",
              changes: [{ path: "src/a.ts", kind: "edit" }, { path: "src/b.ts" }],
            },
          },
        },
        {
          method: "item/completed",
          params: {
            item: {
              id: "mcp_1",
              type: "mcpToolCall",
              server: "linear",
              tool: "create_issue",
              status: "failed",
              error: { message: "auth expired" },
            },
          },
        },
        {
          method: "item/completed",
          params: { item: { id: "search_1", type: "webSearch", query: "drizzle upsert" } },
        },
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_FILE_CHANGE_TOOL_NAME,
        toolCallId: "file_1",
        state: "output-available",
        input: {
          label: "File change",
          changes: [{ path: "src/a.ts", kind: "edit" }, { path: "src/b.ts" }],
        },
        output: {
          status: "completed",
          changes: [{ path: "src/a.ts", kind: "edit" }, { path: "src/b.ts" }],
        },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_MCP_TOOL_NAME,
        toolCallId: "mcp_1",
        state: "output-available",
        input: { label: "MCP tool", server: "linear", tool: "create_issue" },
        output: { status: "failed", error: "auth expired" },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_WEB_SEARCH_TOOL_NAME,
        toolCallId: "search_1",
        state: "output-available",
        input: { label: "Web search", query: "drizzle upsert" },
        output: { status: "completed" },
      },
    ]);
  });

  it("projects a Brain host tool call as a durable generic tool part", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/started",
          params: {
            item: {
              id: "dynamic_1",
              type: "dynamicToolCall",
              tool: "goat_brain",
              arguments: { command: "query", flags: { text: "pricing" } },
            },
          },
        },
        {
          method: "item/completed",
          params: {
            item: {
              id: "dynamic_1",
              type: "dynamicToolCall",
              tool: "goat_brain",
              arguments: { command: "query", flags: { text: "pricing" } },
              status: "completed",
              success: true,
              contentItems: [{ type: "inputText", text: '{"hits":[]}' }],
            },
          },
        },
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_DYNAMIC_TOOL_NAME,
        toolCallId: "dynamic_1",
        state: "output-available",
        input: {
          label: "Brain",
          tool: "goat_brain",
          arguments: { command: "query", flags: { text: "pricing" } },
        },
        output: { status: "completed", success: true },
      },
    ]);
  });

  it("labels a Brain capture host tool clearly", () => {
    const parts = reduce(
      [],
      [
        {
          method: "item/started",
          params: {
            item: {
              id: "dynamic_save_1",
              type: "dynamicToolCall",
              tool: "save_to_brain",
              arguments: { content: "Remember this." },
            },
          },
        },
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_DYNAMIC_TOOL_NAME,
        toolCallId: "dynamic_save_1",
        state: "input-available",
        input: {
          label: "Save to Brain",
          tool: "save_to_brain",
          arguments: { content: "Remember this." },
        },
      },
    ]);
  });

  it("projects goal, question, and approval request states", () => {
    const parts = reduce(
      [],
      [
        {
          method: "thread/goal/updated",
          params: {
            goal: {
              objective: "Ship this UI",
              status: "active",
              tokenBudget: 1000,
              tokensUsed: 25,
            },
          },
        },
        {
          method: "userInput/requested",
          params: { itemId: "question_1", question: "Which branch should I use?" },
        },
        {
          method: "approval/requested",
          params: { itemId: "approval_1", title: "Apply patch", action: "apply_patch" },
        },
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_GOAL_TOOL_NAME,
        toolCallId: `${CODEX_GOAL_TOOL_NAME}_1`,
        state: "output-available",
        input: { label: "Goal" },
        output: {
          objective: "Ship this UI",
          status: "active",
          tokenBudget: 1000,
          tokensUsed: 25,
        },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_QUESTION_TOOL_NAME,
        toolCallId: "question_1",
        state: "approval-requested",
        input: { label: "Question", question: "Which branch should I use?" },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_APPROVAL_TOOL_NAME,
        toolCallId: "approval_1",
        state: "approval-requested",
        input: { label: "Approval", title: "Apply patch", action: "apply_patch" },
      },
    ]);
  });
});

describe("finalizeCodexUiMessageParts", () => {
  const dangling: CodexUiMessagePart[] = [
    { type: "text", text: "Working on it." },
    {
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      toolCallId: "cmd_1",
      state: "input-available",
      input: { command: "sleep 100" },
    },
  ];

  it("marks dangling commands interrupted", () => {
    const projection = finalizeCodexUiMessageParts(dangling, "interrupted");
    expect(projection.changed).toBe(true);
    expect(projection.parts[1]).toMatchObject({
      state: "output-available",
      output: { status: "interrupted", exitCode: null },
    });
  });

  it("marks dangling commands failed with the turn error", () => {
    const projection = finalizeCodexUiMessageParts(dangling, "failed", "sandbox died");
    expect(projection.parts[1]).toMatchObject({ state: "output-error", errorText: "sandbox died" });
  });

  it("is a no-op when nothing is dangling", () => {
    const projection = finalizeCodexUiMessageParts([{ type: "text", text: "done" }], "interrupted");
    expect(projection.changed).toBe(false);
  });

  it("settles unanswered questions and approvals on every outcome", () => {
    const waiting: CodexUiMessagePart[] = [
      {
        type: "dynamic-tool",
        toolName: CODEX_QUESTION_TOOL_NAME,
        toolCallId: "question_1",
        state: "approval-requested",
        input: { label: "Question", question: "Which branch?" },
      },
    ];

    for (const outcome of ["completed", "interrupted", "failed"] as const) {
      const projection = finalizeCodexUiMessageParts(waiting, outcome);
      expect(projection.changed).toBe(true);
      expect(projection.parts[0]).toMatchObject({
        state: "output-available",
        input: { label: "Question", question: "Which branch?" },
        output: { status: "unanswered", question: "Which branch?" },
      });
    }
  });

  it("settles in-flight status parts with the turn outcome but leaves commands alone on success", () => {
    const inFlight: CodexUiMessagePart[] = [
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_1",
        state: "input-available",
        input: { command: "sleep 100" },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_FILE_CHANGE_TOOL_NAME,
        toolCallId: "file_1",
        state: "input-available",
        input: { label: "File change", changes: [{ path: "src/a.ts" }] },
      },
    ];

    const failed = finalizeCodexUiMessageParts(inFlight, "failed", "sandbox died");
    expect(failed.parts[0]).toMatchObject({ state: "output-error", errorText: "sandbox died" });
    expect(failed.parts[1]).toMatchObject({
      state: "output-available",
      output: { status: "failed", changes: [{ path: "src/a.ts" }] },
    });

    const completed = finalizeCodexUiMessageParts(inFlight, "completed");
    expect(completed.parts[0]).toEqual(inFlight[0]);
    expect(completed.parts[1]).toMatchObject({
      state: "output-available",
      output: { status: "completed" },
    });
  });
});

describe("parseCodexUiMessageParts", () => {
  it("round-trips persisted parts and drops malformed entries", () => {
    const parts: CodexUiMessagePart[] = [
      { type: "reasoning", text: "thinking", state: "done" },
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_1",
        state: "output-available",
        input: { command: "ls" },
        output: { status: "completed", exitCode: 0, outputPreview: "apps" },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_PLAN_TOOL_NAME,
        toolCallId: "plan_1",
        state: "output-available",
        input: { label: "Plan" },
        output: { status: "completed", text: "1. Read code" },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_QUESTION_TOOL_NAME,
        toolCallId: "question_1",
        state: "approval-requested",
        input: { label: "Question", question: "Continue?" },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_FILE_CHANGE_TOOL_NAME,
        toolCallId: "file_1",
        state: "output-available",
        input: { label: "File change", changes: [{ path: "src/a.ts" }] },
        output: { status: "completed", changes: [{ path: "src/a.ts" }] },
      },
      {
        type: "dynamic-tool",
        toolName: CODEX_DYNAMIC_TOOL_NAME,
        toolCallId: "dynamic_1",
        state: "output-available",
        input: { label: "Brain", tool: "goat_brain" },
        output: { status: "completed", success: true },
      },
      { type: "text", text: "hello" },
    ];
    expect(parseCodexUiMessageParts(JSON.parse(JSON.stringify(parts)))).toEqual(parts);
    expect(parseCodexUiMessageParts([{ type: "bogus" }, null, 5])).toEqual([]);
    expect(parseCodexUiMessageParts("nope")).toEqual([]);
  });
});

describe("subagent (Task) nesting", () => {
  it("nests a subagent's steps under its Task part and finalizes on completion", () => {
    const parts = reduceNormalized(
      [],
      [
        normalizedEvent("subagent.started", {
          itemId: "task_1",
          description: "Find bugs",
          subagentType: "Explore",
          prompt: "Look for bugs",
        }),
        // Nested reasoning + command from the subagent, stamped with the parent id.
        normalizedEvent("reasoning.completed", {
          itemId: "msg:0",
          text: "thinking",
          parentToolCallId: "task_1",
        }),
        normalizedEvent("command.started", {
          itemId: "nested_1",
          command: "ls",
          parentToolCallId: "task_1",
        }),
        normalizedEvent("command.completed", {
          itemId: "nested_1",
          command: "ls",
          output: { status: "completed", exitCode: null },
          parentToolCallId: "task_1",
        }),
        normalizedEvent("subagent.completed", {
          itemId: "task_1",
          status: "completed",
          result: "Found 2 bugs",
        }),
      ],
    );

    expect(parts).toHaveLength(1);
    const subagent = parts[0] as CodexUiSubagentPart;
    expect(subagent.type).toBe(CODEX_SUBAGENT_TOOL_PART_TYPE);
    expect(subagent.state).toBe("output-available");
    expect(subagent.input).toMatchObject({
      label: "Subagent",
      description: "Find bugs",
      subagentType: "Explore",
    });
    expect(subagent.state === "output-available" && subagent.output).toMatchObject({
      status: "completed",
      result: "Found 2 bugs",
    });
    expect(subagent.children.map((child) => child.type)).toEqual([
      "reasoning",
      CODEX_COMMAND_TOOL_PART_TYPE,
    ]);
    // Nested text does not leak into the parent turn's visible content.
    expect(codexUiMessagePartsContent(parts)).toBe("");
  });

  it("drops nested events whose parent Task part has not arrived", () => {
    const parts = reduceNormalized(
      [],
      [normalizedEvent("assistant.completed", { content: "orphan", parentToolCallId: "task_x" })],
    );
    expect(parts).toEqual([]);
  });

  it("finalize settles a dangling subagent and its in-flight children", () => {
    const running = reduceNormalized(
      [],
      [
        normalizedEvent("subagent.started", { itemId: "task_1", description: "Work" }),
        normalizedEvent("command.started", {
          itemId: "nested_1",
          command: "sleep 1",
          parentToolCallId: "task_1",
        }),
      ],
    );
    const settled = finalizeCodexUiMessageParts(running, "interrupted").parts;
    const subagent = settled[0] as CodexUiSubagentPart;
    expect(subagent.state).toBe("output-available");
    expect(subagent.state === "output-available" && subagent.output.status).toBe("interrupted");
    const nestedCommand = subagent.children[0];
    expect(nestedCommand?.type).toBe(CODEX_COMMAND_TOOL_PART_TYPE);
    expect(nestedCommand && "state" in nestedCommand && nestedCommand.state).toBe(
      "output-available",
    );
  });

  it("round-trips a persisted subagent part with nested children", () => {
    const parts: CodexUiMessagePart[] = [
      {
        type: CODEX_SUBAGENT_TOOL_PART_TYPE,
        toolCallId: "task_1",
        input: { label: "Subagent", description: "Find bugs", subagentType: "Explore" },
        children: [
          { type: "reasoning", text: "thinking", state: "done" },
          {
            type: CODEX_COMMAND_TOOL_PART_TYPE,
            toolCallId: "nested_1",
            state: "output-available",
            input: { command: "ls" },
            output: { status: "completed", exitCode: null },
          },
        ],
        state: "output-available",
        output: { status: "completed", result: "Found 2 bugs" },
      },
    ];
    expect(parseCodexUiMessageParts(JSON.parse(JSON.stringify(parts)))).toEqual(parts);
  });
});
