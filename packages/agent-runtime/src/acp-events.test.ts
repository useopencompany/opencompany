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
      goal: null,
    });
  });

  it("accumulates usage across a repaired prompt in the same run", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");
    normalizer.normalize({
      method: "session/prompt_result",
      params: {
        sessionId: "session_1",
        stopReason: "end_turn",
        usage: { inputTokens: 8, outputTokens: 2, cachedReadTokens: 5 },
      },
    });
    normalizer.normalize(
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Recovered result" },
      }),
    );
    normalizer.normalize({
      method: "session/prompt_result",
      params: {
        sessionId: "session_1",
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 4, cachedWriteTokens: 7 },
      },
    });

    expect(normalizer.summary()).toMatchObject({
      result: "Recovered result",
      usage: {
        input_tokens: 11,
        output_tokens: 6,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      },
    });
  });

  it("normalizes Codex goals, plans, nested subagents, terminal output, and MCP identity", () => {
    const normalizer = createAcpEventNormalizer({ engineName: "Codex" });
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "session_info_update",
          _meta: {
            goal: {
              objective: "Finish the migration",
              status: "active",
              tokenBudget: 10_000,
              tokensUsed: 250,
              timeUsedSeconds: 30,
            },
          },
        }),
      ),
    ).toMatchObject([
      {
        type: "goal.updated",
        payload: {
          objective: "Finish the migration",
          status: "active",
          tokenBudget: 10_000,
        },
      },
    ]);
    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "plan_update",
          planId: "plan_1",
          plan: { content: "1. Inspect\n2. Implement" },
        }),
      ),
    ).toMatchObject([
      {
        type: "plan.updated",
        payload: { itemId: "plan_1", text: "1. Inspect\n2. Implement" },
      },
    ]);

    const [subagent] = normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "agent_1",
        title: "Inspect the repository",
        rawInput: { prompt: "Find the event adapter." },
        _meta: { codex: { subagent: { threadId: "thread_child" } } },
      }),
    );
    expect(subagent).toMatchObject({
      type: "subagent.started",
      payload: { itemId: "agent_1", prompt: "Find the event adapter." },
    });

    const [collaborator] = normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "agent_2",
        title: "Review the adapter",
        rawInput: { prompt: "Check the provider contract." },
        _meta: { codex: { collaboration: { senderThreadId: "agent_1" } } },
      }),
    );
    expect(collaborator).toMatchObject({
      type: "subagent.started",
      payload: { itemId: "agent_2", parentToolCallId: "agent_1" },
    });

    const [command] = normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "command_1",
        title: "Run tests",
        kind: "execute",
        rawInput: { command: "bun test" },
        _meta: { codex: { subagent: { parentToolCallId: "agent_1" } } },
      }),
    );
    expect(command).toMatchObject({
      type: "command.started",
      payload: { parentToolCallId: "agent_1", command: "bun test" },
    });
    expect(
      normalizer
        .normalize(
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "command_1",
            status: "completed",
            rawOutput: { exit_code: 0 },
            _meta: { terminal_output: { data: "12 tests passed" } },
          }),
        )
        .map((event) => event.type),
    ).toEqual(["command.output", "command.completed"]);

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "mcp_1",
          title: "List actions",
          rawInput: { server: "opencompany", tool: "list_actions" },
        }),
      ),
    ).toMatchObject([
      {
        type: "mcp_tool.started",
        payload: { server: "opencompany", tool: "list_actions" },
      },
    ]);

    normalizer.normalize({
      method: "session/prompt_result",
      params: { sessionId: "session_1", stopReason: "end_turn" },
    });
    expect(normalizer.summary()?.goal).toEqual({
      objective: "Finish the migration",
      status: "active",
      tokenBudget: 10_000,
      tokensUsed: 250,
      timeUsedSeconds: 30,
    });
  });

  it("normalizes ACP reasoning, file edits, web searches, and provider usage updates", () => {
    const normalizer = createAcpEventNormalizer({ engineName: "Codex" });
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "agent_thought_chunk",
          messageId: "thought_1",
          content: { type: "text", text: "Inspecting the affected boundary." },
        }),
      ),
    ).toMatchObject([
      {
        type: "reasoning.completed",
        payload: { itemId: "thought_1", text: "Inspecting the affected boundary." },
      },
    ]);
    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "edit_1",
          title: "Edit the adapter",
          kind: "edit",
          locations: [{ path: "apps/runner/src/acp-engine-adapters.ts" }],
        }),
      ),
    ).toMatchObject([
      {
        type: "file_change.started",
        payload: {
          itemId: "edit_1",
          changes: [{ path: "apps/runner/src/acp-engine-adapters.ts", kind: "edit" }],
        },
      },
    ]);
    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "search_1",
          title: "Search the web",
          kind: "search",
          rawInput: { query: "ACP steering extension" },
          status: "completed",
        }),
      ),
    ).toMatchObject([
      {
        type: "web_search.started",
        payload: { itemId: "search_1", query: "ACP steering extension" },
      },
      {
        type: "web_search.completed",
        payload: { itemId: "search_1", query: "ACP steering extension", status: "completed" },
      },
    ]);
    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "usage_update",
          used: 512,
          size: 16_384,
          cost: { amount: 0.01, currency: "USD" },
        }),
      ),
    ).toMatchObject([
      {
        type: "usage.updated",
        payload: { contextUsage: { used: 512, size: 16_384 } },
      },
    ]);
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

  it("replaces an initial command placeholder and carries its description", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "command_1",
          title: "Terminal",
          kind: "execute",
          _meta: { claudeCode: { toolName: "Bash" } },
          status: "in_progress",
        }),
      ),
    ).toMatchObject([{ type: "command.started", payload: { command: "Terminal" } }]);

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "command_1",
          rawInput: {
            command: "git status --short",
            description: "Check the working tree",
          },
          status: "completed",
          rawOutput: { exitCode: 0 },
        }),
      ),
    ).toMatchObject([
      {
        type: "command.completed",
        payload: {
          command: "git status --short",
          description: "Check the working tree",
        },
      },
    ]);
  });

  it("preserves Claude tool names, ACP kinds, titles, and streamed queries", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "read_1",
          title: "Read the package manifest",
          kind: "read",
          _meta: { claudeCode: { toolName: "Read" } },
          rawInput: { file_path: "package.json" },
        }),
      ),
    ).toMatchObject([
      {
        type: "mcp_tool.started",
        payload: {
          toolName: "Read",
          kind: "read",
          title: "Read the package manifest",
        },
      },
    ]);

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "grep_1",
          title: "Search source files",
          kind: "search",
          _meta: { claudeCode: { toolName: "Grep" } },
        }),
      ),
    ).toMatchObject([
      {
        type: "web_search.started",
        payload: {
          toolName: "Grep",
          kind: "search",
          title: "Search source files",
          query: "Search source files",
        },
      },
    ]);
    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "grep_1",
          rawInput: { query: "normalizeToolCallUpdate" },
          status: "completed",
        }),
      ),
    ).toMatchObject([
      {
        type: "web_search.completed",
        payload: {
          toolName: "Grep",
          kind: "search",
          title: "Search source files",
          query: "normalizeToolCallUpdate",
        },
      },
    ]);

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "todo_1",
          title: "Update the task list",
          kind: "think",
          _meta: { claudeCode: { toolName: "TodoWrite" } },
          rawInput: { todos: [] },
        }),
      ),
    ).toMatchObject([
      {
        type: "mcp_tool.started",
        payload: { toolName: "TodoWrite", kind: "think", title: "Update the task list" },
      },
    ]);
  });

  it("prefers streamed MCP server and tool identity over initial values", () => {
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("session_1");
    normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "mcp_1",
        name: "mcp__placeholder__placeholder",
        title: "MCP tool",
        status: "in_progress",
      }),
    );

    expect(
      normalizer.normalize(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "mcp_1",
          rawInput: { server: "workspace", tool: "lookup" },
          status: "completed",
        }),
      ),
    ).toMatchObject([
      {
        type: "mcp_tool.completed",
        payload: {
          toolName: "mcp__workspace__lookup",
          server: "workspace",
          tool: "lookup",
        },
      },
    ]);
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

  it("normalizes the pinned Codex ACP MCP envelope instead of treating it as a command", () => {
    const normalizer = createAcpEventNormalizer({ engineName: "Codex" });
    normalizer.beginRun("session_1");

    const events = normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "mcp_1",
        kind: "execute",
        title: "mcp.opencompany.list_actions",
        status: "completed",
        rawInput: {
          server: "opencompany",
          tool: "list_actions",
          arguments: { category: "database" },
        },
        rawOutput: {
          result: {
            content: [{ type: "text", text: "Found the Neon actions." }],
          },
          error: null,
        },
        _meta: { is_mcp_tool_call: true },
      }),
    );

    expect(events).toMatchObject([
      {
        type: "mcp_tool.started",
        payload: {
          itemId: "mcp_1",
          toolName: "mcp__opencompany__list_actions",
          kind: "execute",
          server: "opencompany",
          tool: "list_actions",
          rawInput: { category: "database" },
        },
      },
      {
        type: "mcp_tool.completed",
        payload: {
          itemId: "mcp_1",
          server: "opencompany",
          tool: "list_actions",
          status: "completed",
          rawInput: { category: "database" },
          result: expect.stringContaining("Found the Neon actions."),
        },
      },
    ]);
    expect(events.map((event) => event.type)).not.toContain("command.started");
  });

  it("surfaces errors from the pinned Codex ACP MCP envelope", () => {
    const normalizer = createAcpEventNormalizer({ engineName: "Codex" });
    normalizer.beginRun("session_1");

    const events = normalizer.normalize(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "mcp_failed",
        kind: "execute",
        title: "mcp.opencompany.use_action",
        status: "failed",
        rawInput: {
          server: "opencompany",
          tool: "use_action",
          arguments: { action: "neon.query" },
        },
        rawOutput: {
          result: null,
          error: { message: "Connection unavailable" },
        },
        _meta: { is_mcp_tool_call: true },
      }),
    );

    expect(events).toMatchObject([
      { type: "mcp_tool.started" },
      {
        type: "mcp_tool.completed",
        payload: {
          status: "failed",
          rawInput: { action: "neon.query" },
          error: expect.stringContaining("Connection unavailable"),
        },
      },
    ]);
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
