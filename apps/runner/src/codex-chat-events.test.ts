import {
  CODEX_COMMAND_TOOL_PART_TYPE,
  CODEX_MCP_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_PART_TYPE,
  type CodexUiMessagePart,
  createAcpEventNormalizer,
} from "@opencompany/agent-runtime";
import type { RunExecutionRepository } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexChatLeaseLostError } from "./codex-chat-errors";
import {
  createExternalEngineProjector,
  type ExternalEngineProjectorTarget,
} from "./codex-chat-events";

const mocks = vi.hoisted(() => ({
  captureProductLlmUsageRecorded: vi.fn(async () => undefined),
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
  execute: vi.fn(),
}));

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductLlmUsageRecorded: mocks.captureProductLlmUsageRecorded,
}));

vi.mock("@opencompany/observability", () => ({
  captureException: mocks.captureException,
  createLogger: mocks.createLogger,
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

describe("createExternalEngineProjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps projecting a valid event when its auxiliary audit insert fails", async () => {
    const databaseError = Object.assign(new Error("query details must not be reported"), {
      code: "23514",
    });
    mocks.execute
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rows: [{ id: "goat_chat_msg_assistant_1" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
    });

    await expect(projector.push([fileChangeStartedEvent()])).resolves.toBeUndefined();

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "CodexChatEventPersistenceError",
        message: "opencompany Codex chat audit event persistence failed.",
      }),
      expect.objectContaining({
        event: "opencompany.goat_codex_chat_event_persist_failed",
        turn_id: "goat_codex_chat_turn_1",
        event_type: "file_change.started",
        original_error_code: "23514",
      }),
    );
    expect(mocks.captureException.mock.calls[0]?.[0]).not.toBe(databaseError);
  });

  it("still aborts projection when the event insert proves the turn lease was lost", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
    });

    await expect(projector.push([fileChangeStartedEvent()])).rejects.toBeInstanceOf(
      CodexChatLeaseLostError,
    );

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reports audit failures safely when an error has a cyclic cause", async () => {
    const cyclicError = new Error("cyclic query error") as Error & { cause?: unknown };
    cyclicError.cause = cyclicError;
    mocks.execute
      .mockRejectedValueOnce(cyclicError)
      .mockResolvedValueOnce({ rows: [{ id: "goat_chat_msg_assistant_1" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
    });

    await expect(projector.push([fileChangeStartedEvent()])).resolves.toBeUndefined();

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ original_error_code: undefined }),
    );
  });

  it("does not project a replayed completed item twice", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "event_1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "message_1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "event_1" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
    });
    const event = {
      method: "session/update",
      params: {
        sessionId: "codex_session_1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "file_change_1",
          title: "Edit src/index.ts",
          kind: "edit",
          status: "completed",
          locations: [{ path: "src/index.ts" }],
        },
      },
    };

    await projector.push([event]);
    await projector.push([event]);

    const statements = mocks.execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements.filter((query) => query.includes("UPDATE goat.chat_messages"))).toHaveLength(
      1,
    );
    expect(statements).toContainEqual(expect.stringContaining("event_key"));
  });

  it("keeps the session queued until a queued follow-up turn is claimed", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
    });

    await projector.finalize({
      sessionId: "codex_thread_1",
      status: "success",
      result: "Done",
      error: null,
      usage: null,
      goal: null,
    });

    const sessionUpdate = mocks.execute.mock.calls
      .map(([query]) => sqlText(query))
      .find((query) => query.includes("UPDATE goat.codex_chat_sessions AS runtime"));
    expect(sessionUpdate).toContain("WITH settled_turn AS");
    expect(sessionUpdate).toContain("UPDATE goat.codex_chat_turns AS turn");
    expect(sessionUpdate).toContain("queued.status = 'queued'");
    expect(sessionUpdate).toContain("queued.run_after IS NULL OR queued.run_after <=");
    expect(sessionUpdate).toContain("ORDER BY queued.created_at ASC, queued.id ASC");
    expect(sessionUpdate).toContain("THEN 'queued'");
    expect(sessionUpdate).toContain("ELSE idle");
  });

  it("recovers a committed publication into the terminal assistant message", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            artifactId: "artifact_1",
            artifactVersionId: "version_1",
            version: 1,
            title: "Launch plan",
            description: "The final plan.",
            filename: "plan.md",
            mediaType: "text/markdown",
            sizeBytes: 42,
            state: "ready",
          },
        ],
      })
      .mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await projector.finalize({
      sessionId: "codex_thread_1",
      status: "success",
      result: "The plan is ready.",
      error: null,
      usage: null,
      goal: null,
    });

    const messageUpdate = mocks.execute.mock.calls
      .map(([query]) => query)
      .find((query) => sqlText(query).includes("UPDATE goat.chat_messages AS message"));
    expect(queryValues(messageUpdate)).toContainEqual(
      expect.stringContaining(
        '"type":"data-artifact-file","data":{"artifactId":"artifact_1","artifactVersionId":"version_1"',
      ),
    );
  });

  it("captures Codex token usage in PostHog analytics when a turn finalizes", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget({
        workspaceId: "workspace_1",
        engine: "codex",
        model: "gpt-5.5-codex",
      }),
      redact: (value) => value,
    });

    await projector.finalize({
      sessionId: "codex_thread_1",
      status: "success",
      result: "Done",
      error: null,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 30,
      },
      goal: null,
    });

    expect(mocks.captureProductLlmUsageRecorded).toHaveBeenCalledWith({
      distinctId: "user_1",
      workspaceId: "workspace_1",
      surface: "chat",
      stage: "execution",
      sessionId: "goat_chat_1",
      messageId: "goat_chat_msg_user_1",
      taskId: undefined,
      turnId: "goat_codex_chat_turn_1",
      modelProvider: "openai",
      model: "gpt-5.5-codex",
      engine: "codex",
      inputTokens: 100,
      inputNoCacheTokens: 75,
      inputCacheReadTokens: 20,
      inputCacheWriteTokens: 5,
      outputTokens: 30,
      outputTextTokens: 30,
      outputReasoningTokens: 0,
      totalTokens: 130,
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      chargedCostUsdMicros: 0,
      billable: false,
      finishReason: "success",
    });
  });

  it("captures Claude Code token usage in PostHog analytics when a turn finalizes", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget({
        workspaceId: "workspace_1",
        engine: "claude_code",
        model: "claude-sonnet-5",
      }),
      redact: (value) => value,
    });

    await projector.finalize({
      sessionId: "claude_session_1",
      status: "success",
      result: "Done",
      error: null,
      usage: {
        input_tokens: 50,
        output_tokens: 10,
      },
      goal: null,
    });

    expect(mocks.captureProductLlmUsageRecorded).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user_1",
        workspaceId: "workspace_1",
        surface: "chat",
        stage: "execution",
        sessionId: "goat_chat_1",
        messageId: "goat_chat_msg_user_1",
        turnId: "goat_codex_chat_turn_1",
        modelProvider: "anthropic",
        model: "claude-sonnet-5",
        engine: "claude_code",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        billable: false,
      }),
    );
  });

  it("durably projects and resolves an ACP user-input request", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const execution = {
      appendEvents: vi.fn(async (input: Parameters<RunExecutionRepository["appendEvents"]>[0]) =>
        input.events.map((event, index) => ({ ...event, sequence: index + 1 })),
      ),
    } as unknown as RunExecutionRepository;
    const projector = createExternalEngineProjector({
      target: projectorTarget({ canonicalAttemptId: "attempt_1" }),
      redact: (value) => value,
      execution,
    });

    const interaction = await projector.requestUserInput(userInputRequest());
    expect(interaction.interactionId).toMatch(/^goat_codex_chat_interaction_/);
    expect(mocks.execute.mock.calls.map(([query]) => sqlText(query))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO goat.codex_chat_interactions"),
        expect.stringContaining("INSERT INTO goat.run_approvals"),
        expect.stringContaining("INSERT INTO goat.codex_chat_events"),
        expect.stringContaining("UPDATE goat.chat_messages AS message"),
      ]),
    );

    await projector.resolveInteraction(interaction.interactionId, "answered");
    expect(mocks.execute).toHaveBeenCalledTimes(6);
    expect(mocks.execute.mock.calls.map(([query]) => sqlText(query))).toContainEqual(
      expect.stringContaining("UPDATE goat.run_approvals AS approval"),
    );
  });

  it("persists and resolves an ACP permission through run_approvals", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("claude_session_1");
    const projector = createExternalEngineProjector({
      target: projectorTarget({ engine: "claude_code" }),
      redact: (value) => value,
      normalizeEvent: normalizer.normalize,
    });

    const approval = await projector.requestApproval({
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "claude_session_1",
        toolCall: {
          toolCallId: "command_1",
          title: "Run tests",
          rawInput: { command: "bun test" },
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    expect(approval.approvalId).toMatch(/^opencompany_acp_permission_/);
    expect(mocks.execute.mock.calls.map(([query]) => sqlText(query))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/INSERT INTO goat\.run_approvals[\s\S]*'acp_permission'/),
        expect.stringContaining("INSERT INTO goat.codex_chat_events"),
        expect.stringContaining("UPDATE goat.chat_messages AS message"),
      ]),
    );
    expect(mocks.execute.mock.calls.flatMap(([query]) => queryValues(query))).toEqual(
      expect.arrayContaining(["command_1", JSON.stringify(["allow_once", "reject_once"])]),
    );

    await projector.resolveApproval(approval.approvalId, "approved");
    expect(mocks.execute.mock.calls.map(([query]) => sqlText(query))).toContainEqual(
      expect.stringContaining("UPDATE goat.chat_messages AS message"),
    );
  });

  it("writes ACP assistant deltas directly to the durable partial message", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const normalizer = createAcpEventNormalizer();
    normalizer.beginRun("claude_session_1");
    const projector = createExternalEngineProjector({
      target: projectorTarget({ engine: "claude_code" }),
      redact: (value) => value,
      normalizeEvent: normalizer.normalize,
    });

    await projector.push([
      {
        method: "session/update",
        params: {
          sessionId: "claude_session_1",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message_1",
            content: { type: "text", text: "Persist this before interrupt." },
          },
        },
      },
    ]);

    expect(mocks.execute).toHaveBeenCalledOnce();
    const [query] = mocks.execute.mock.calls[0] ?? [];
    expect(sqlText(query)).toContain("UPDATE goat.chat_messages AS message");
    expect(queryValues(query)).toContainEqual(
      expect.stringContaining("Persist this before interrupt."),
    );
  });

  it("persists Codex ACP MCP arguments and results in the durable tool part", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const normalizer = createAcpEventNormalizer({ engineName: "Codex" });
    normalizer.beginRun("codex_session_1");
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value.replaceAll("sensitive-value", "[redacted]"),
      normalizeEvent: normalizer.normalize,
    });

    await projector.push([
      {
        method: "session/update",
        params: {
          sessionId: "codex_session_1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "mcp_1",
            kind: "execute",
            title: "mcp.opencompany.use_action",
            status: "completed",
            rawInput: {
              server: "opencompany",
              tool: "use_action",
              arguments: { action: "neon.query", input: "sensitive-value" },
            },
            rawOutput: {
              result: { content: [{ type: "text", text: "Returned sensitive-value" }] },
              error: null,
            },
            _meta: { is_mcp_tool_call: true },
          },
        },
      },
    ]);

    const persistedDebugTrace = messageUpdates()
      .flatMap((query) => queryValues(query))
      .filter(
        (value): value is string =>
          typeof value === "string" && value.includes("goat.codex_chat.debug.v1"),
      )
      .at(-1);
    expect(persistedDebugTrace).toBeDefined();
    expect(JSON.parse(persistedDebugTrace ?? "{}")).toMatchObject({
      uiMessageParts: [
        {
          type: "dynamic-tool",
          toolName: CODEX_MCP_TOOL_NAME,
          toolCallId: "mcp_1",
          state: "output-available",
          input: {
            server: "opencompany",
            tool: "use_action",
            arguments: { action: "neon.query", input: "[redacted]" },
          },
          output: {
            status: "completed",
            result: expect.stringContaining("Returned [redacted]"),
          },
        },
      ],
    });
    expect(persistedDebugTrace).not.toContain("sensitive-value");
  });

  it("debounces durable chat_messages writes across rapid assistant deltas", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    let clock = 0;
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
      now: () => clock,
      assistantWriteDebounceMs: 2000,
    });

    await projector.push([agentMessageChunk("First. ")]); // clock 0: first delta persists immediately
    clock = 500;
    await projector.push([agentMessageChunk("Second. ")]); // debounced
    clock = 1000;
    await projector.push([agentMessageChunk("Third. ")]); // debounced
    clock = 2000;
    await projector.push([agentMessageChunk("Fourth.")]); // window elapsed: persists again

    const messageWrites = messageUpdates();
    expect(messageWrites).toHaveLength(2);
    expect(queryValues(messageWrites[1])).toContainEqual(
      expect.stringContaining("First. Second. Third. Fourth."),
    );
  });

  it("emits the live SSE projection for every delta while the durable write is debounced", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const appendEvents = vi.fn(
      async (input: Parameters<RunExecutionRepository["appendEvents"]>[0]) =>
        input.events.map((event, index) => ({ ...event, sequence: index + 1 })),
    );
    let clock = 0;
    const projector = createExternalEngineProjector({
      target: projectorTarget({ canonicalAttemptId: "attempt_1" }),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
      execution: { appendEvents } as unknown as RunExecutionRepository,
      now: () => clock,
      assistantWriteDebounceMs: 2000,
    });

    await projector.push([agentMessageChunk("First. ")]);
    clock = 500;
    await projector.push([agentMessageChunk("Second. ")]);
    clock = 1000;
    await projector.push([agentMessageChunk("Third.")]);

    // Only the first delta committed the durable row; the rest were debounced.
    expect(messageUpdates()).toHaveLength(1);
    // The live surface still received a content update for all three deltas.
    const contentUpdates = appendEvents.mock.calls
      .flatMap(([input]) => input.events)
      .filter((event) => event.type === "message.content_updated");
    expect(contentUpdates).toHaveLength(3);
    expect(contentUpdates.at(-1)?.payload).toMatchObject({ content: "First. Second. Third." });
  });

  it("forces a durable write on a part boundary inside the debounce window", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    let clock = 0;
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
      now: () => clock,
      assistantWriteDebounceMs: 2000,
    });

    await projector.push([agentMessageChunk("Thinking. ")]); // clock 0: first write
    clock = 100;
    await projector.push([fileChangeStartedEvent()]); // boundary: forced despite the open window

    expect(messageUpdates()).toHaveLength(2);
  });

  it("forces a final durable write when the turn finalizes inside the debounce window", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    let clock = 0;
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
      now: () => clock,
      assistantWriteDebounceMs: 2000,
    });

    await projector.push([agentMessageChunk("Working. ")]); // clock 0: first write
    clock = 100;
    await projector.finalize({
      sessionId: "codex_thread_1",
      status: "success",
      result: "Working. Done.",
      error: null,
      usage: null,
      goal: null,
    });

    // Terminal settle commits the final row even though the debounce window is still open.
    expect(messageUpdates()).toHaveLength(2);
  });

  it("debounces streamed reasoning chunks like text deltas", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    let clock = 0;
    const projector = createExternalEngineProjector({
      target: projectorTarget({ engine: "claude_code" }),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
      now: () => clock,
      assistantWriteDebounceMs: 2000,
    });

    // ACP maps every agent_thought_chunk to reasoning.completed; a reasoning-heavy turn streams many.
    await projector.push([agentThoughtChunk("Considering. ")]); // clock 0: first write
    clock = 400;
    await projector.push([agentThoughtChunk("Still thinking. ")]); // debounced
    clock = 800;
    await projector.push([agentThoughtChunk("Almost there.")]); // debounced

    // Only the first chunk commits the durable row; the rest stay within the debounce window.
    expect(messageUpdates()).toHaveLength(1);
  });

  it("emits redacted tool metadata and parent linkage for the live transcript", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const appendEvents = vi.fn(
      async (input: Parameters<RunExecutionRepository["appendEvents"]>[0]) =>
        input.events.map((event, index) => ({ ...event, sequence: index + 1 })),
    );
    const command = `secret-token ${"x".repeat(4_100)}`;
    const initialParts: CodexUiMessagePart[] = [
      {
        type: CODEX_SUBAGENT_TOOL_PART_TYPE,
        toolCallId: "subagent_1",
        state: "input-available",
        input: {
          label: "Subagent",
          description: "Inspect the repository",
          subagentType: "Explore",
        },
        children: [
          {
            type: CODEX_COMMAND_TOOL_PART_TYPE,
            toolCallId: "command_1",
            state: "output-available",
            input: { command },
            output: { status: "completed", exitCode: 0 },
          },
          {
            type: "dynamic-tool",
            toolName: CODEX_MCP_TOOL_NAME,
            toolCallId: "mcp_1",
            state: "output-available",
            input: { label: "MCP tool", server: "github", tool: "search" },
            output: { status: "completed" },
          },
        ],
      },
    ];
    const projector = createExternalEngineProjector({
      target: projectorTarget({ canonicalAttemptId: "attempt_1" }),
      redact: (value) => value.replaceAll("secret-token", "[redacted]"),
      initialParts,
      normalizeEvent: () => [
        {
          type: "assistant.delta",
          payload: { itemId: "assistant_1", delta: "Working" },
          rawEvent: {},
        },
      ],
      execution: { appendEvents } as unknown as RunExecutionRepository,
    });

    await projector.push([{}]);

    const emitted = appendEvents.mock.calls.flatMap(([input]) => input.events);
    const started = emitted.filter((event) => event.type === "tool.started");
    expect(started).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            toolCallId: "subagent_1",
            name: "codex_subagent",
            label: "Subagent",
            detail: "Inspect the repository",
            kind: "Explore",
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            toolCallId: "mcp_1",
            name: "codex_mcp_tool",
            label: "MCP tool",
            detail: "github.search",
            kind: "mcp",
            parentToolCallId: "subagent_1",
          }),
        }),
      ]),
    );
    const commandStarted = started.find((event) => event.payload.toolCallId === "command_1");
    expect(commandStarted?.payload).toMatchObject({
      name: "codex_command",
      label: "Command",
      kind: "execute",
      parentToolCallId: "subagent_1",
    });
    expect(commandStarted?.payload.detail).toHaveLength(4_000);
    expect(commandStarted?.payload.detail).toContain("[redacted]");
    expect(commandStarted?.payload.detail).not.toContain("secret-token");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        payload: { toolCallId: "command_1", summary: "completed" },
      }),
    );
  });

  it("rejects malformed user-input requests before persistence", async () => {
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
    });

    await expect(
      projector.requestUserInput({
        ...userInputRequest(),
        params: { questions: [] },
      }),
    ).rejects.toThrow("invalid user-input request");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("serializes notification and server-request projection writes", async () => {
    let releaseFirst: (value: { rows: Array<{ id: string }> }) => void = (_value) => {
      throw new Error("Deferred database call was not initialized.");
    };
    mocks.execute
      .mockImplementationOnce(
        () =>
          new Promise<{ rows: Array<{ id: string }> }>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue({ rows: [{ id: "updated_row" }] });
    const projector = createExternalEngineProjector({
      target: projectorTarget(),
      redact: (value) => value,
      normalizeEvent: acpNormalizer(),
    });

    const first = projector.push([fileChangeStartedEvent("file_change_1")]);
    const second = projector.push([fileChangeStartedEvent("file_change_2")]);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    releaseFirst({ rows: [{ id: "event_1" }] });
    await Promise.all([first, second]);

    expect(mocks.execute).toHaveBeenCalledTimes(4);
  });
});

function projectorTarget(overrides: Partial<ExternalEngineProjectorTarget> = {}) {
  return { ...projectorTargetBase(), ...overrides };
}

function projectorTargetBase(): ExternalEngineProjectorTarget {
  return {
    userWorkosId: "user_1",
    workspaceId: null,
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    turnId: "goat_codex_chat_turn_1",
    userMessageId: "goat_chat_msg_user_1",
    assistantMessageId: "goat_chat_msg_assistant_1",
    model: "gpt-5.5",
    engine: "codex" as const,
    leaseId: "goat_codex_chat_lease_1",
    leaseOwner: "runner_1",
    planMode: false,
  };
}

function fileChangeStartedEvent(id = "file_change_1") {
  return {
    method: "session/update",
    params: {
      sessionId: "codex_session_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: "Edit src/index.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "src/index.ts" }],
      },
    },
  };
}

function agentMessageChunk(text: string, messageId = "assistant_message_1") {
  return {
    method: "session/update",
    params: {
      sessionId: "codex_session_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      },
    },
  };
}

function agentThoughtChunk(text: string) {
  return {
    method: "session/update",
    params: {
      sessionId: "codex_session_1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    },
  };
}

// The durable assistant row is written via `UPDATE goat.chat_messages … WHERE message.role =
// 'assistant'`. Match on the role predicate so we count only the debounced/forced content writes
// and not the settle path's task-tagging CTE (which also updates goat.chat_messages).
function messageUpdates() {
  return mocks.execute.mock.calls
    .map(([query]) => query)
    .filter(
      (query) =>
        sqlText(query).includes("UPDATE goat.chat_messages AS message") &&
        sqlText(query).includes("message.role = 'assistant'"),
    );
}

function acpNormalizer() {
  const normalizer = createAcpEventNormalizer({ engineName: "Codex" });
  normalizer.beginRun("codex_session_1");
  return normalizer.normalize;
}

function userInputRequest() {
  return {
    id: "request_1",
    method: "elicitation/create",
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
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value?: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value ?? "");
      }
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
      return "";
    })
    .join("");
}

function queryValues(query: unknown) {
  const values: unknown[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      if (typeof value !== "undefined") values.push(value);
      return;
    }
    if ("queryChunks" in value && Array.isArray((value as { queryChunks?: unknown }).queryChunks)) {
      for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) visit(chunk);
      return;
    }
    if ("value" in value && Array.isArray((value as { value?: unknown }).value)) return;
    values.push(value);
  };
  visit(query);
  return values;
}
