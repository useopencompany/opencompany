import { describe, expect, it } from "vitest";
import { createClaudeCodeEventNormalizer } from "./claude-code-events";

function assistantEvent(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: { id: "msg_1", content },
    session_id: "sess_1",
    ...overrides,
  };
}

function toolResultEvent(blocks: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: "user",
    message: { content: blocks },
    session_id: "sess_1",
    ...overrides,
  };
}

describe("createClaudeCodeEventNormalizer", () => {
  it("maps system init to turn.started and captures the session id", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize({
      type: "system",
      subtype: "init",
      session_id: "sess_1",
      model: "claude-sonnet-5",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turn.started");
    expect(events[0]?.payload).toMatchObject({ threadId: "sess_1", turnId: "sess_1" });
    expect(normalizer.sessionId()).toBe("sess_1");
  });

  it("maps text and thinking blocks to assistant/reasoning events", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize(
      assistantEvent([
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "hello" },
      ]),
    );
    expect(events.map((event) => event.type)).toEqual([
      "reasoning.completed",
      "assistant.completed",
    ]);
    expect(events[0]?.payload).toMatchObject({ itemId: "msg_1:0", text: "pondering" });
    expect(events[1]?.payload).toMatchObject({ itemId: "msg_1:1", content: "hello" });
  });

  it("maps Bash tool_use/tool_result to command lifecycle with output preview", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const started = normalizer.normalize(
      assistantEvent([{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } }]),
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.type).toBe("command.started");
    expect(started[0]?.payload).toMatchObject({ itemId: "tool_1", command: "ls" });

    const completed = normalizer.normalize(
      toolResultEvent([{ type: "tool_result", tool_use_id: "tool_1", content: "file.txt" }]),
    );
    expect(completed.map((event) => event.type)).toEqual(["command.output", "command.completed"]);
    expect(completed[0]?.payload).toMatchObject({ itemId: "tool_1", delta: "file.txt" });
    expect(completed[1]?.payload).toMatchObject({
      itemId: "tool_1",
      command: "ls",
      output: { status: "completed", exitCode: null },
    });
  });

  it("maps failed Bash tool_result to command.failed", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    normalizer.normalize(
      assistantEvent([
        { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "false" } },
      ]),
    );
    const events = normalizer.normalize(
      toolResultEvent([
        { type: "tool_result", tool_use_id: "tool_1", content: "boom", is_error: true },
      ]),
    );
    expect(events.map((event) => event.type)).toEqual(["command.output", "command.failed"]);
    expect(events[1]?.payload).toMatchObject({ itemId: "tool_1", error: "boom" });
  });

  it("maps Edit/Write tools to file_change events", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const started = normalizer.normalize(
      assistantEvent([
        { type: "tool_use", id: "tool_2", name: "Edit", input: { file_path: "/repo/a.ts" } },
      ]),
    );
    expect(started[0]?.type).toBe("file_change.started");
    expect(started[0]?.payload).toMatchObject({
      itemId: "tool_2",
      changes: [{ path: "/repo/a.ts", kind: "edit" }],
    });

    const completed = normalizer.normalize(
      toolResultEvent([{ type: "tool_result", tool_use_id: "tool_2", content: "ok" }]),
    );
    expect(completed[0]?.type).toBe("file_change.completed");
    expect(completed[0]?.payload).toMatchObject({ itemId: "tool_2", status: "completed" });
  });

  it("maps WebSearch and WebFetch to web_search events", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize(
      assistantEvent([
        { type: "tool_use", id: "tool_3", name: "WebSearch", input: { query: "weather" } },
        { type: "tool_use", id: "tool_4", name: "WebFetch", input: { url: "https://a.dev" } },
      ]),
    );
    expect(events.map((event) => event.type)).toEqual(["web_search.started", "web_search.started"]);
    expect(events[0]?.payload).toMatchObject({ query: "weather" });
    expect(events[1]?.payload).toMatchObject({ query: "https://a.dev" });
  });

  it("maps TodoWrite to a single replaced plan part and skips its tool_result", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize(
      assistantEvent([
        {
          type: "tool_use",
          id: "tool_5",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "step one", status: "completed" },
              { content: "step two", status: "in_progress" },
              { content: "step three", status: "pending" },
            ],
          },
        },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("plan.updated");
    expect(events[0]?.payload).toMatchObject({
      itemId: "claude-plan",
      status: "completed",
      text: "- [x] step one\n- [~] step two\n- [ ] step three",
    });

    const result = normalizer.normalize(
      toolResultEvent([{ type: "tool_result", tool_use_id: "tool_5", content: "ok" }]),
    );
    expect(result).toEqual([]);
  });

  it("maps other tools (Read, mcp__*) to mcp_tool events with server parsing", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize(
      assistantEvent([
        { type: "tool_use", id: "tool_6", name: "Read", input: { file_path: "/a" } },
        { type: "tool_use", id: "tool_7", name: "mcp__linear__list_issues", input: {} },
      ]),
    );
    expect(events.map((event) => event.type)).toEqual(["mcp_tool.started", "mcp_tool.started"]);
    expect(events[0]?.payload).toMatchObject({ tool: "Read" });
    expect(events[1]?.payload).toMatchObject({ server: "linear", tool: "list_issues" });

    const failed = normalizer.normalize(
      toolResultEvent([
        { type: "tool_result", tool_use_id: "tool_7", content: "denied", is_error: true },
      ]),
    );
    expect(failed[0]?.type).toBe("mcp_tool.completed");
    expect(failed[0]?.payload).toMatchObject({ status: "failed", error: "denied" });
  });

  it("extracts text from array tool_result content", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    normalizer.normalize(
      assistantEvent([{ type: "tool_use", id: "tool_8", name: "Bash", input: { command: "pwd" } }]),
    );
    const events = normalizer.normalize(
      toolResultEvent([
        {
          type: "tool_result",
          tool_use_id: "tool_8",
          content: [{ type: "text", text: "/repo" }],
        },
      ]),
    );
    expect(events[0]?.payload).toMatchObject({ delta: "/repo" });
  });

  it("skips subagent traffic carrying parent_tool_use_id", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    expect(
      normalizer.normalize(
        assistantEvent([{ type: "text", text: "nested" }], { parent_tool_use_id: "tool_9" }),
      ),
    ).toEqual([]);
    expect(
      normalizer.normalize(
        toolResultEvent([{ type: "tool_result", tool_use_id: "tool_9", content: "x" }], {
          parent_tool_use_id: "tool_9",
        }),
      ),
    ).toEqual([]);
  });

  it("maps a success result to turn.completed + usage.updated and records the summary", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    normalizer.normalize({ type: "system", subtype: "init", session_id: "sess_1" });
    const events = normalizer.normalize({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "All done.",
      session_id: "sess_1",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(events.map((event) => event.type)).toEqual(["turn.completed", "usage.updated"]);
    expect(events[0]?.payload).toMatchObject({ turnId: "sess_1", status: "completed" });
    expect(normalizer.summary()).toEqual({
      status: "success",
      result: "All done.",
      error: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      sessionId: "sess_1",
    });
  });

  // Captured from claude CLI 2.1.49: a stale --resume id fails with is_error=true,
  // no `result` string, and the message in an `errors: string[]` field.
  it("surfaces the errors[] field of a failed result in the summary", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    normalizer.normalize({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      session_id: "sess_2",
      usage: { input_tokens: 0, output_tokens: 0 },
      errors: ["No conversation found with session ID: 00000000-dead-beef"],
    });
    expect(normalizer.summary()).toMatchObject({
      status: "failure",
      error: "No conversation found with session ID: 00000000-dead-beef",
    });
  });

  // Captured from claude 2.1.220 in an e2b sandbox with an invalid token: auth
  // failures report subtype "success" with is_error=true and api_error_status 401.
  it("treats is_error results as failures even when subtype is success", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate",
      session_id: "sess_3",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(events[0]?.payload).toMatchObject({ status: "failed" });
    expect(normalizer.summary()).toMatchObject({
      status: "failure",
      error: "Failed to authenticate (HTTP 401)",
    });
  });

  it("maps error results to a failed summary", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    const events = normalizer.normalize({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: "sess_1",
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    expect(events[0]?.payload).toMatchObject({ status: "failed" });
    expect(normalizer.summary()?.status).toBe("failure");
    expect(normalizer.summary()?.error).toContain("error_max_turns");
  });

  it("maps unknown event shapes to unknown", () => {
    const normalizer = createClaudeCodeEventNormalizer();
    expect(normalizer.normalize({ type: "stream_event" })[0]?.type).toBe("unknown");
    expect(normalizer.normalize({ type: "system", subtype: "api_retry" })[0]?.type).toBe("unknown");
  });
});
