import { describe, expect, it } from "vitest";
import { createAcpEventNormalizer } from "./acp-events";

function update(value: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "session_1", update: value },
  };
}

describe("createAcpEventNormalizer", () => {
  it("streams root assistant text and builds a terminal summary with usage", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize({ method: "session/started", params: { sessionId: "session_1" } }),
    ).toMatchObject([{ type: "turn.started" }]);
    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        }),
      ),
    ).toMatchObject([
      { type: "assistant.delta", payload: { itemId: "acp-message-root", delta: "Hello" } },
    ]);
    normalizer.normalize(
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" },
      }),
    );

    expect(
      normalizer
        .normalize({
          method: "session/prompt_result",
          params: {
            sessionId: "session_1",
            stopReason: "end_turn",
            usage: {
              inputTokens: 11,
              outputTokens: 7,
              cachedReadTokens: 3,
              cachedWriteTokens: 2,
            },
          },
        })
        .map((event) => event.type),
    ).toEqual(["turn.completed", "usage.updated"]);
    expect(normalizer.summary()).toEqual({
      status: "success",
      result: "Hello world",
      error: null,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
      sessionId: "session_1",
    });
  });

  it("nests subagent transcript events without adding child text to the root result", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");

    const [started] = normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "agent_1",
        title: "Research the codebase",
        kind: "other",
        _meta: { claudeCode: { toolName: "Agent", subagent: true } },
        rawInput: { prompt: "Find the implementation." },
      }),
    );
    expect(started).toMatchObject({
      type: "subagent.started",
      payload: { itemId: "agent_1", prompt: "Find the implementation." },
    });

    const [child] = normalizer.normalize(
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "child_message",
        content: { type: "text", text: "Nested findings" },
        _meta: { claudeCode: { parentToolUseId: "agent_1" } },
      }),
    );
    expect(child).toMatchObject({
      type: "assistant.delta",
      payload: { itemId: "child_message", parentToolCallId: "agent_1" },
    });

    normalizer.normalize(
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "root_message",
        content: { type: "text", text: "Root answer" },
      }),
    );
    normalizer.normalize({
      method: "session/prompt_result",
      params: { sessionId: "session_1", stopReason: "end_turn" },
    });
    expect(normalizer.summary()?.result).toBe("Root answer");
  });

  it("maps command progress and completion into the neutral command lifecycle", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "command_1",
          title: "Run tests",
          kind: "execute",
          rawInput: { command: "bun test" },
          status: "in_progress",
        }),
      ),
    ).toMatchObject([
      { type: "command.started", payload: { itemId: "command_1", command: "bun test" } },
    ]);

    expect(
      normalizer
        .normalize(
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "command_1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "2 passed" } }],
            rawOutput: { exitCode: 0 },
          }),
        )
        .map((event) => event.type),
    ).toEqual(["command.output", "command.completed"]);
  });

  it("carries MCP tool arguments and result through the completed event", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "search_1",
          title: "ToolSearch",
          name: "ToolSearch",
          rawInput: { query: "select:Read", max_results: 5 },
          status: "in_progress",
        }),
      ),
    ).toMatchObject([
      {
        type: "mcp_tool.started",
        payload: { itemId: "search_1", tool: "ToolSearch", rawInput: { query: "select:Read" } },
      },
    ]);

    const [event] = normalizer.normalize(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "search_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Found 3 tools." } }],
      }),
    );

    expect(event).toMatchObject({
      type: "mcp_tool.completed",
      payload: {
        itemId: "search_1",
        tool: "ToolSearch",
        status: "completed",
        rawInput: { query: "select:Read", max_results: 5 },
        result: "Found 3 tools.",
      },
    });
  });

  it("extracts safe file metadata from a completed publish_artifact call", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");
    normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "publish_1",
        title: "Publish artifact",
        name: "mcp__opencompany_actions__publish_artifact",
        rawInput: { path: "plan.md" },
        status: "in_progress",
      }),
    );

    const [event] = normalizer.normalize(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "publish_1",
        status: "completed",
        rawOutput: {
          ok: true,
          artifact: {
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
      }),
    );

    expect(event).toMatchObject({
      type: "mcp_tool.completed",
      payload: {
        server: "opencompany_actions",
        tool: "publish_artifact",
        artifact: { artifactVersionId: "version_1", state: "ready" },
      },
    });
  });

  it("maps permission requests to a distinct approval projection", () => {
    const normalizer = createAcpEventNormalizer();
    const [event] = normalizer.normalize({
      id: 9,
      interactionId: "opencompany_acp_permission_1",
      method: "session/request_permission",
      params: {
        sessionId: "session_1",
        toolCall: {
          toolCallId: "command_1",
          title: "Run release command",
          rawInput: { command: "bun publish" },
        },
        options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
      },
    });

    expect(event).toMatchObject({
      type: "approval.requested",
      payload: {
        itemId: "acp-approval-command_1",
        requestId: 9,
        interactionId: "opencompany_acp_permission_1",
        title: "Run release command",
        action: "bun publish",
      },
    });
  });
});
