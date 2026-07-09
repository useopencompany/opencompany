import { describe, expect, it } from "vitest";
import { normalizeCodexAppServerEvent } from "./codex-app-server-events";
import {
  applyCodexEventToUiMessageParts,
  CODEX_COMMAND_TOOL_PART_TYPE,
  type CodexUiMessagePart,
  codexUiMessagePartsContent,
  createCodexCommandOutputAccumulator,
  finalizeCodexUiMessageParts,
  parseCodexUiMessageParts,
} from "./codex-ui-message-parts";

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
      { type: "text", text: "hello" },
    ];
    expect(parseCodexUiMessageParts(JSON.parse(JSON.stringify(parts)))).toEqual(parts);
    expect(parseCodexUiMessageParts([{ type: "bogus" }, null, 5])).toEqual([]);
    expect(parseCodexUiMessageParts("nope")).toEqual([]);
  });
});
