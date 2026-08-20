import { describe, expect, it } from "vitest";
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
  resolveCodexUiApproval,
  resolveCodexUiInteraction,
} from "./codex-ui-message-parts";
import type { HarnessNormalizedEvent } from "./harness-events";

function normalizedEvent(
  type: HarnessNormalizedEvent["type"],
  payload: Record<string, unknown>,
): HarnessNormalizedEvent {
  return { type, payload, rawEvent: {} };
}

function reduceNormalized(parts: CodexUiMessagePart[], raw: HarnessNormalizedEvent[]) {
  let current = parts;
  for (const event of raw) {
    current = applyCodexEventToUiMessageParts(current, event).parts;
  }
  return current;
}

describe("applyCodexEventToUiMessageParts", () => {
  it("coalesces streamed assistant deltas by item id", () => {
    const first = applyCodexEventToUiMessageParts(
      [],
      normalizedEvent("assistant.delta", { itemId: "message_1", delta: "Hello" }),
    );
    const second = applyCodexEventToUiMessageParts(
      first.parts,
      normalizedEvent("assistant.delta", { itemId: "message_1", delta: " world" }),
    );

    expect(second.parts).toEqual([{ type: "text", itemId: "message_1", text: "Hello world" }]);
    expect(codexUiMessagePartsContent(second.parts)).toBe("Hello world");
  });

  it("projects and resolves an ACP permission approval", () => {
    const waiting = applyCodexEventToUiMessageParts(
      [],
      normalizedEvent("approval.requested", {
        itemId: "acp-approval-command_1",
        interactionId: "opencompany_acp_permission_1",
        title: "Run tests",
        action: "bun test",
        options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
      }),
    ).parts;

    expect(waiting[0]).toMatchObject({
      type: "dynamic-tool",
      toolName: CODEX_APPROVAL_TOOL_NAME,
      toolCallId: "acp-approval-command_1",
      state: "approval-requested",
      approval: { id: "opencompany_acp_permission_1" },
    });

    expect(
      resolveCodexUiApproval(waiting, {
        approvalId: "opencompany_acp_permission_1",
        status: "approved",
      }).parts[0],
    ).toMatchObject({
      state: "output-available",
      output: { status: "approved" },
    });
  });

  it("inserts a published file at tool completion without a transient tool row", () => {
    const started = applyCodexEventToUiMessageParts(
      [{ type: "text", text: "I created the plan." }],
      normalizedEvent("dynamic_tool.started", {
        itemId: "publish_1",
        tool: "publish_artifact",
        arguments: { path: "plan.md" },
      }),
    );
    expect(started.changed).toBe(false);

    const completed = applyCodexEventToUiMessageParts(
      started.parts,
      normalizedEvent("dynamic_tool.completed", {
        itemId: "publish_1",
        tool: "publish_artifact",
        status: "completed",
        success: true,
        artifact: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          title: "Launch plan",
          filename: "plan.md",
          mediaType: "text/markdown",
          sizeBytes: 42,
          state: "ready",
        },
      }),
    );

    expect(completed.parts).toEqual([
      { type: "text", text: "I created the plan." },
      {
        type: "data-artifact-file",
        data: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          title: "Launch plan",
          filename: "plan.md",
          mediaType: "text/markdown",
          sizeBytes: 42,
          state: "ready",
        },
      },
    ]);
  });

  it("keeps a subagent-published file at the top level of the assistant response", () => {
    const parts = applyCodexEventToUiMessageParts(
      [
        {
          type: CODEX_SUBAGENT_TOOL_PART_TYPE,
          toolCallId: "task_1",
          state: "input-available",
          input: { label: "Analyst" },
          children: [],
        },
      ],
      normalizedEvent("mcp_tool.completed", {
        itemId: "publish_1",
        parentToolCallId: "task_1",
        tool: "publish_artifact",
        status: "completed",
        artifact: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          title: "Analysis",
          filename: "analysis.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: 1_024,
          state: "ready",
        },
      }),
    ).parts;

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: CODEX_SUBAGENT_TOOL_PART_TYPE, children: [] });
    expect(parts[1]).toMatchObject({
      type: "data-artifact-file",
      data: { artifactVersionId: "version_1", filename: "analysis.xlsx" },
    });
  });

  it("folds MCP tool arguments and result into the durable part", () => {
    const parts = reduceNormalized(
      [],
      [
        normalizedEvent("mcp_tool.started", {
          itemId: "search_1",
          tool: "ToolSearch",
          rawInput: { query: "select:Read", max_results: 5 },
        }),
        normalizedEvent("mcp_tool.completed", {
          itemId: "search_1",
          tool: "ToolSearch",
          status: "completed",
          rawInput: { query: "select:Read", max_results: 5 },
          result: "Found 3 tools.",
        }),
      ],
    );

    expect(parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_MCP_TOOL_NAME,
        toolCallId: "search_1",
        state: "output-available",
        input: {
          label: "MCP tool",
          tool: "ToolSearch",
          arguments: { query: "select:Read", max_results: 5 },
        },
        output: { status: "completed", result: "Found 3 tools." },
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
  it("restores a resolved ACP approval after a runner reclaim", () => {
    expect(
      parseCodexUiMessageParts([
        {
          type: "dynamic-tool",
          toolName: CODEX_APPROVAL_TOOL_NAME,
          toolCallId: "acp-approval-command_1",
          state: "approval-responded",
          input: { title: "Run tests", action: "bun test" },
          approval: { id: "approval_1", approved: true },
        },
      ]),
    ).toEqual([
      {
        type: "dynamic-tool",
        toolName: CODEX_APPROVAL_TOOL_NAME,
        toolCallId: "acp-approval-command_1",
        state: "output-available",
        input: { title: "Run tests", action: "bun test" },
        output: { status: "approved" },
      },
    ]);
  });

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
      {
        type: "data-artifact-file",
        data: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          title: "Plan",
          filename: "plan.md",
          mediaType: "text/markdown",
          sizeBytes: 42,
          state: "ready",
        },
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
