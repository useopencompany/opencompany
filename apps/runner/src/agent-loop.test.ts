import {
  type AgentConfig,
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  type RuntimeToolDefinition,
} from "@opencompany/agent-runtime";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionToolUsage,
  agentSessionUsage,
  agents,
} from "@opencompany/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireRunLease,
  appendRuntimeEventForLease,
  assertTurnComplete,
  buildAmpCommand,
  buildAmpCommandEnv,
  collectAssistantStream,
  completeAssistantMessageForLease,
  createAgentDelegationHandler,
  createAmpActivityFormatter,
  createAmpStreamAccumulator,
  createAssistantMessageForLease,
  createHostedToolBudget,
  createKnownSecretRedactor,
  createToolStartCoordinator,
  detectIncompleteTurn,
  executeRuntimeTool,
  MAX_MODEL_STEPS,
  normalizeReasoningSummary,
  readReasoningTextDelta,
  recordStepUsage,
  recordToolUsage,
  selectPublishBranch,
  ToolStepLimitExceededError,
  throwIfStreamErrorPart,
} from "./agent-loop";
import { loadGitHubWorkRepository } from "./amp-tool";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent, publishTransientRuntimeEvent } from "./events";
import { type LeaseWriteStore, setLeaseWriteStoreForTests } from "./lease-writes";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

const observabilityMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

const braintrustMocks = vi.hoisted(() => ({
  getBraintrustAISDK: vi.fn((aiSDK: object) => aiSDK),
  flushBraintrust: vi.fn(async () => {}),
  logBraintrustCurrentSpan: vi.fn(),
  logBraintrustSpan: vi.fn(),
  traceBraintrust: vi.fn(
    async (
      _input: unknown,
      run: (span: { log: (fields: unknown) => void } | undefined) => Promise<unknown>,
    ) => run({ log: vi.fn() }),
  ),
  traceBraintrustStep: vi.fn(
    async (
      _name: string,
      run: (span: { log: (fields: unknown) => void } | undefined) => Promise<unknown>,
    ) => run({ log: vi.fn() }),
  ),
}));

const githubMocks = vi.hoisted(() => ({
  createDraftPullRequest: vi.fn(),
  getGitHubWorkInstallationToken: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("@opencompany/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/observability")>();
  return {
    ...actual,
    captureException: observabilityMocks.captureException,
  };
});

vi.mock("@opencompany/observability/braintrust", () => braintrustMocks);

vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
  publishTransientRuntimeEvent: vi.fn((event) => ({ ...event, id: null, transient: true })),
}));

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return {
    ...actual,
    createDraftPullRequest: githubMocks.createDraftPullRequest,
    getGitHubWorkInstallationToken: githubMocks.getGitHubWorkInstallationToken,
  };
});

// Lease-guarded DB writes run atomic conditional statements that the hand-rolled fake
// db cannot interpret, so route them through an in-memory store bound to the current
// fake db's `state`. Reads, the lease claim, and the ledger debit still hit the fake db.
beforeEach(() => {
  setLeaseWriteStoreForTests(
    createStateLeaseWriteStore(() => (dbMocks.getDb() as { state: LeaseDbState }).state),
  );
});

afterEach(() => {
  setLeaseWriteStoreForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("run lease acquisition", () => {
  it("blocks acquisition while a non-expired lease is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const db = createLeaseDb({
      runLeaseId: "run_active",
      runLeaseExpiresAt: new Date("2026-05-22T12:05:00.000Z"),
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      acquireRunLease({
        sessionId: "ses_123",
        messageId: "msg_user",
        leaseId: "run_next",
        leaseOwner: "runner-test",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      }),
    ).resolves.toBe(false);

    expect(db.state.session.runLeaseId).toBe("run_active");
  });

  it("replaces an expired lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const db = createLeaseDb({
      runLeaseId: "run_stale",
      runLeaseExpiresAt: new Date("2026-05-22T11:59:00.000Z"),
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      acquireRunLease({
        sessionId: "ses_123",
        messageId: "msg_user",
        leaseId: "run_next",
        leaseOwner: "runner-test",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      }),
    ).resolves.toBe(true);

    expect(db.state.session.runLeaseId).toBe("run_next");
    expect(db.state.session.runLeaseOwner).toBe("runner-test");
    expect(db.state.session.runLeaseMessageId).toBe("msg_user");
    expect(db.state.session.runLeaseExpiresAt).toEqual(new Date("2026-05-22T12:15:00.000Z"));
  });
});

describe("lease-guarded writes", () => {
  it("deduplicates assistant responses for the same user message", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_1",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(true);
    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_2",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(false);

    expect(db.state.messages).toHaveLength(1);
    expect(db.state.messages[0]).toMatchObject({
      id: "msg_assistant_1",
      responseToMessageId: "msg_user",
    });
    expect(appendRuntimeEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects event writes when the lease guard writes no row", async () => {
    const db = createLeaseDb({ runLeaseId: "run_current" });
    dbMocks.getDb.mockReturnValue(db);
    // The atomic append inserts only while the lease is current; a lost lease writes
    // nothing and resolves to null. appendRuntimeEventForLease must surface that as a
    // rejected lease write rather than a success.
    vi.mocked(appendRuntimeEvent).mockResolvedValueOnce(null);

    await expect(
      appendRuntimeEventForLease({
        sessionId: "ses_123",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        type: "session.status",
        payload: { status: "running" },
      }),
    ).resolves.toBe(false);
  });

  it("rejects assistant completion under the wrong lease", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_current",
      messages: [{ id: "msg_assistant", sessionId: "ses_123", status: "running" }],
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      completeAssistantMessageForLease({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        content: "done",
        modelMessage: { role: "assistant", content: "done" },
      }),
    ).rejects.toThrow("Run lease is no longer current.");

    expect(db.state.messages[0]?.status).toBe("running");
  });
});

describe("usage recording", () => {
  it("records model usage with sequential step indexes", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordStepUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 1,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response: {
        id: "response_1",
        timestamp: new Date("2026-05-22T12:00:00.000Z"),
        modelId: "openai/gpt-5.4-mini",
      },
      usage: usage(100, 20),
      finishReason: "tool-calls",
      rawFinishReason: undefined,
    });
    await recordStepUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 2,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response: {
        id: "response_2",
        timestamp: new Date("2026-05-22T12:00:01.000Z"),
        modelId: "openai/gpt-5.4-mini",
      },
      usage: usage(80, 30),
      finishReason: "stop",
      rawFinishReason: undefined,
    });

    expect(db.state.usage.map((row) => row.stepIndex)).toEqual([1, 2]);
    expect(db.state.ledgerDebits).toBe(2);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.usage",
        payload: expect.objectContaining({ stepIndex: 1 }),
      }),
    );
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.usage",
        payload: expect.objectContaining({ stepIndex: 2 }),
      }),
    );
  });

  it("records hosted tool usage and emits usage events", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordToolUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      toolCallId: "call_exa",
      toolName: "exa_search",
      usage: {
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_123",
        costUsdMicros: 7000,
        rawUsage: { costDollars: { total: 0.007 } },
      },
    });

    expect(db.state.toolUsage).toEqual([
      expect.objectContaining({
        toolCallId: "call_exa",
        toolName: "exa_search",
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_123",
        costUsdMicros: 7000,
      }),
    ]);
    expect(db.state.ledgerDebits).toBe(1);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.tool_usage",
        payload: expect.objectContaining({
          toolCallId: "call_exa",
          provider: "exa",
          costUsdMicros: 7000,
        }),
      }),
    );
  });

  it("executes hosted tools without hydrating the sandbox", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              requestId: "exa_req_123",
              searchType: "auto",
              costDollars: { total: 0.001 },
              results: [],
            }),
            { status: 200 },
          ),
      ),
    );
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_exa",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
      args: { query: "test" },
      getSandbox,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.toolUsage).toHaveLength(1);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "exa_search",
      toolCallId: "call_exa",
    });
  });

  it("records Amp usage streamed through the runtime tool dispatcher", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_123",
      githubRows: [
        {
          integrationId: "wint_123",
          fullName: "opencompany/web",
          installationId: "12345",
          connectionLabel: "opencompany",
          connectionStatus: "connected",
          connectionStatusReason: null,
          resourceStatus: "available",
          resourceStatusReason: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    githubMocks.getGitHubWorkInstallationToken.mockResolvedValue("github_token_123");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ threadID: "T-amp-usage", usage: 0.00815 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const sandboxRun = vi.fn(
      async (command: string, options?: { onStdout?: (data: string) => void }) => {
        if (command.includes("git rev-parse --is-inside-work-tree")) return { stdout: "true" };
        if (command.includes("amp --dangerously-allow-all")) {
          options?.onStdout?.(
            `${JSON.stringify({
              type: "assistant",
              message: {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "working" }],
                usage: { input_tokens: 100, output_tokens: 20 },
              },
              session_id: "T-amp-usage",
            })}\n`,
          );
          options?.onStdout?.(
            `${JSON.stringify({
              type: "result",
              subtype: "success",
              duration_ms: 500,
              is_error: false,
              num_turns: 1,
              result: "done",
              session_id: "T-amp-usage",
              usage: {
                input_tokens: 1_000,
                cache_creation_input_tokens: 25,
                cache_read_input_tokens: 50,
                output_tokens: 100,
              },
            })}\n`,
          );
          return { stdout: "", exitCode: 0 };
        }
        if (command.includes("git status --short")) return { stdout: "" };
        if (command.includes("git diff HEAD --stat")) return { stdout: "" };
        if (command.includes("git diff HEAD -- | head -400")) return { stdout: "" };
        if (command.includes("git branch --show-current")) return { stdout: "main\n" };
        if (command.includes("git rev-list --count")) return { stdout: "0\n" };
        return { stdout: "" };
      },
    );
    const ampAgentConfig = agentConfig();
    ampAgentConfig.tools = [
      {
        id: "amp",
        type: "coding_agent",
        provider: "amp",
        label: "Amp",
        description: "Delegate coding work to Amp.",
        prCapable: false,
      },
    ];
    ampAgentConfig.integrations.github.repositories = [
      {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      },
    ];

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: ampAgentConfig,
        toolCallId: "call_amp",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("amp_coder") as RuntimeToolDefinition,
        args: { task: "implement the change" },
        getSandbox: (async () => ({
          sandboxId: "sbx_amp",
          commands: { run: sandboxRun },
        })) as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["amp_coder"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toMatchObject({
      ampThreadId: "T-amp-usage",
      usage: {
        provider: "amp",
        operation: "session",
        costUsdMicros: 8_150,
        rawUsage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 50,
          output_tokens: 100,
        },
      },
    });

    expect(db.state.toolUsage).toEqual([
      expect.objectContaining({
        toolCallId: "call_amp",
        toolName: "amp_coder",
        provider: "amp",
        operation: "session",
        costUsdMicros: 8_150,
      }),
    ]);
    expect(db.state.ledgerDebits).toBe(1);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.tool_usage",
        payload: expect.objectContaining({
          toolCallId: "call_amp",
          provider: "amp",
          operation: "session",
          costUsdMicros: 8_150,
        }),
      }),
    );
  });

  it("executes agent delegation as an internal tool without hydrating the sandbox", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });
    const delegateToAgent = vi.fn(async () => ({
      ok: true,
      status: "completed",
      childSessionId: "ses_child",
      answer: "Research complete.",
    }));

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_delegate",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("delegate_to_agent") as RuntimeToolDefinition,
      args: { agent: "agent/research", prompt: "Summarize the market." },
      getSandbox,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "delegate_to_agent"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
      delegateToAgent,
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(delegateToAgent).toHaveBeenCalledWith({
      agent: "agent/research",
      prompt: "Summarize the market.",
      toolCallId: "call_delegate",
    });
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "delegate_to_agent",
      toolCallId: "call_delegate",
      content: expect.stringContaining("Research complete."),
    });
  });

  it("creates delegated child sessions with durable parent linkage", async () => {
    const db = createDelegationDb();
    dbMocks.getDb.mockReturnValue(db);
    const runChildMessage = vi.fn(async ({ sessionId, messageId }) => {
      db.state.messages.push({
        id: "msg_child_answer",
        sessionId,
        role: "assistant",
        status: "completed",
        content: "Research complete.",
        responseToMessageId: messageId,
      });
      return null;
    });

    const delegate = createAgentDelegationHandler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentRunLeaseId: "run_parent",
      parentRunLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      userId: "usr_123",
      env: env(),
      signal: new AbortController().signal,
      checkAbort: async () => {},
      depth: 0,
      agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
      runChildMessage,
    });

    const result = await delegate({
      agent: "agent/research",
      prompt: "Summarize the market.",
      toolCallId: "call_delegate",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      agentName: "Research",
      agentPath: "agents/research/research.agent",
      answer: "Research complete.",
    });
    expect(db.state.sessions[0]).toMatchObject({
      workspaceId: "wsp_123",
      userId: "usr_123",
      agentId: "agt_research",
      source: "agent",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentToolCallId: "call_delegate",
    });
    expect(runChildMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: db.state.sessions[0]?.id,
        depth: 0,
      }),
    );
  });

  it("emits delegated usage rollups on the parent session", async () => {
    const db = createDelegationDb({
      sessions: [
        {
          id: "ses_parent",
          workspaceId: "wsp_123",
          userId: "usr_123",
          agentId: "agt_parent",
          status: "running",
          parentSessionId: null,
          runLeaseId: "run_parent",
          archivedAt: null,
        },
      ],
      rollupRow: {
        inputTokens: 100,
        inputNoCacheTokens: 80,
        inputCacheReadTokens: 10,
        inputCacheWriteTokens: 10,
        outputTokens: 25,
        outputTextTokens: 20,
        outputReasoningTokens: 5,
        totalTokens: 125,
        providerCostUsdMicros: 1000,
        platformFeeUsdMicros: 100,
        totalCostUsdMicros: 1100,
        modelCostUsdMicros: 770,
        toolCostUsdMicros: 330,
        toolUsageTotalCostUsdMicros: 300,
        toolUsageByProviderOperation: [
          { provider: "exa", operation: "search", costUsdMicros: 300, calls: 1 },
        ],
      },
    });
    dbMocks.getDb.mockReturnValue(db);
    const runChildMessage = vi.fn(async ({ sessionId, messageId }) => {
      db.state.messages.push({
        id: "msg_child_answer",
        sessionId,
        role: "assistant",
        status: "completed",
        content: "Research complete.",
        responseToMessageId: messageId,
      });
      return null;
    });

    const delegate = createAgentDelegationHandler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentRunLeaseId: "run_parent",
      parentRunLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      userId: "usr_123",
      env: env(),
      signal: new AbortController().signal,
      checkAbort: async () => {},
      depth: 0,
      agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
      runChildMessage,
    });

    await delegate({
      agent: "agent/research",
      prompt: "Summarize the market.",
      toolCallId: "call_delegate",
    });

    const childSession = db.state.sessions.find(
      (session) => session.parentSessionId === "ses_parent",
    );
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "ses_parent",
        messageId: "msg_parent_assistant",
        type: "session.delegated_usage",
        payload: expect.objectContaining({
          childSessionId: childSession?.id,
          parentToolCallId: "call_delegate",
          usage: expect.objectContaining({ totalTokens: 125 }),
          cost: expect.objectContaining({ totalCostUsdMicros: 1100 }),
          toolUsage: expect.objectContaining({ totalCostUsdMicros: 300 }),
        }),
      }),
    );
  });

  it("emits only delegated usage deltas when resuming a child session", async () => {
    const db = createDelegationDb({
      sessions: [
        {
          id: "ses_child",
          workspaceId: "wsp_123",
          userId: "usr_123",
          agentId: "agt_research",
          status: "completed",
          parentSessionId: "ses_parent",
          runLeaseId: null,
          archivedAt: null,
        },
      ],
      rollupRow: {
        inputTokens: 100,
        inputNoCacheTokens: 100,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 25,
        outputTextTokens: 25,
        outputReasoningTokens: 0,
        totalTokens: 125,
        providerCostUsdMicros: 1000,
        platformFeeUsdMicros: 100,
        totalCostUsdMicros: 1100,
        modelCostUsdMicros: 1100,
        toolCostUsdMicros: 0,
        toolUsageTotalCostUsdMicros: 0,
        toolUsageByProviderOperation: [],
      },
    });
    dbMocks.getDb.mockReturnValue(db);
    const runChildMessage = vi.fn(async ({ sessionId, messageId }) => {
      db.state.messages.push({
        id: `msg_child_answer_${messageId}`,
        sessionId,
        role: "assistant",
        status: "completed",
        content: "Done.",
        responseToMessageId: messageId,
      });
      return null;
    });

    const delegate = createAgentDelegationHandler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentRunLeaseId: "run_parent",
      parentRunLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      userId: "usr_123",
      env: env(),
      signal: new AbortController().signal,
      checkAbort: async () => {},
      depth: 0,
      agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
      runChildMessage,
    });

    await delegate({
      sessionId: "ses_child",
      prompt: "First pass.",
      toolCallId: "call_delegate_first",
    });
    const firstEvent = vi.mocked(appendRuntimeEvent).mock.calls.at(-1)?.[1];
    db.state.events.push({
      sessionId: "ses_parent",
      type: "session.delegated_usage",
      payload: firstEvent?.payload,
    });
    db.state.rollupRow = {
      inputTokens: 150,
      inputNoCacheTokens: 150,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 40,
      outputTextTokens: 40,
      outputReasoningTokens: 0,
      totalTokens: 190,
      providerCostUsdMicros: 1500,
      platformFeeUsdMicros: 150,
      totalCostUsdMicros: 1650,
      modelCostUsdMicros: 1650,
      toolCostUsdMicros: 0,
      toolUsageTotalCostUsdMicros: 0,
      toolUsageByProviderOperation: [],
    };

    await delegate({
      sessionId: "ses_child",
      prompt: "Follow up.",
      toolCallId: "call_delegate_second",
    });

    expect(appendRuntimeEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "ses_parent",
        type: "session.delegated_usage",
        payload: expect.objectContaining({
          childSessionId: "ses_child",
          parentToolCallId: "call_delegate_second",
          usage: expect.objectContaining({ totalTokens: 65 }),
          cost: expect.objectContaining({ totalCostUsdMicros: 550 }),
        }),
      }),
    );
  });

  it("resumes an existing delegated child session with a new user message", async () => {
    const db = createDelegationDb({
      sessions: [
        {
          id: "ses_child",
          workspaceId: "wsp_123",
          userId: "usr_123",
          agentId: "agt_research",
          status: "completed",
          parentSessionId: "ses_parent",
          runLeaseId: null,
          archivedAt: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const runChildMessage = vi.fn(async ({ sessionId, messageId }) => {
      db.state.messages.push({
        id: "msg_child_answer",
        sessionId,
        role: "assistant",
        status: "completed",
        content: "Follow-up complete.",
        responseToMessageId: messageId,
      });
      return null;
    });

    const delegate = createAgentDelegationHandler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentRunLeaseId: "run_parent",
      parentRunLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      userId: "usr_123",
      env: env(),
      signal: new AbortController().signal,
      checkAbort: async () => {},
      depth: 0,
      agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
      runChildMessage,
    });

    const result = await delegate({
      sessionId: "ses_child",
      prompt: "Continue with pricing.",
      toolCallId: "call_delegate_resume",
    });

    const resumedUserMessage = db.state.messages.find(
      (message) => message.role === "user" && message.content === "Continue with pricing.",
    );
    expect(resumedUserMessage).toBeTruthy();
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      resumed: true,
      childSessionId: "ses_child",
      messageId: resumedUserMessage?.id,
      agentName: "Research",
      agentPath: "agents/research/research.agent",
      answer: "Follow-up complete.",
    });
    expect(runChildMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ses_child",
        messageId: resumedUserMessage?.id,
      }),
    );
  });

  it("rejects resume for sessions outside the current parent session", async () => {
    const db = createDelegationDb({
      sessions: [
        {
          id: "ses_child",
          workspaceId: "wsp_123",
          userId: "usr_123",
          agentId: "agt_research",
          status: "completed",
          parentSessionId: "ses_other",
          runLeaseId: null,
          archivedAt: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const runChildMessage = vi.fn(async () => null);

    const delegate = createAgentDelegationHandler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentRunLeaseId: "run_parent",
      parentRunLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      userId: "usr_123",
      env: env(),
      signal: new AbortController().signal,
      checkAbort: async () => {},
      depth: 0,
      agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
      runChildMessage,
    });

    await expect(
      delegate({
        sessionId: "ses_child",
        prompt: "Continue.",
        toolCallId: "call_delegate_resume",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "failed",
      childSessionId: "ses_child",
      error: expect.stringContaining("not a child session"),
    });
    expect(runChildMessage).not.toHaveBeenCalled();
    expect(db.state.messages).toHaveLength(0);
  });

  it("rejects resume for archived or active child sessions", async () => {
    for (const child of [
      { id: "ses_archived", status: "completed", runLeaseId: null, archivedAt: new Date() },
      { id: "ses_running", status: "running", runLeaseId: "run_child", archivedAt: null },
    ]) {
      const db = createDelegationDb({
        sessions: [
          {
            ...child,
            workspaceId: "wsp_123",
            userId: "usr_123",
            agentId: "agt_research",
            parentSessionId: "ses_parent",
          },
        ],
      });
      dbMocks.getDb.mockReturnValue(db);
      const runChildMessage = vi.fn(async () => null);
      const delegate = createAgentDelegationHandler({
        parentSessionId: "ses_parent",
        parentMessageId: "msg_parent_assistant",
        parentRunLeaseId: "run_parent",
        parentRunLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        userId: "usr_123",
        env: env(),
        signal: new AbortController().signal,
        checkAbort: async () => {},
        depth: 0,
        agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
        runChildMessage,
      });

      await expect(
        delegate({
          sessionId: child.id,
          prompt: "Continue.",
          toolCallId: "call_delegate_resume",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: "failed",
        childSessionId: child.id,
      });
      expect(runChildMessage).not.toHaveBeenCalled();
      expect(db.state.messages).toHaveLength(0);
    }
  });

  it("passes the parent abort signal into resumed child runs", async () => {
    const controller = new AbortController();
    const db = createDelegationDb({
      sessions: [
        {
          id: "ses_child",
          workspaceId: "wsp_123",
          userId: "usr_123",
          agentId: "agt_research",
          status: "completed",
          parentSessionId: "ses_parent",
          runLeaseId: null,
          archivedAt: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const runChildMessage = vi.fn(async ({ sessionId, messageId, signal }) => {
      expect(signal).toBe(controller.signal);
      db.state.messages.push({
        id: "msg_child_answer",
        sessionId,
        role: "assistant",
        status: "completed",
        content: "Follow-up complete.",
        responseToMessageId: messageId,
      });
      return null;
    });

    const delegate = createAgentDelegationHandler({
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent_assistant",
      parentRunLeaseId: "run_parent",
      parentRunLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      userId: "usr_123",
      env: env(),
      signal: controller.signal,
      checkAbort: async () => {},
      depth: 0,
      agentReferences: [{ path: "agents/research/research.agent", name: "Research" }],
      runChildMessage,
    });

    await delegate({
      sessionId: "ses_child",
      prompt: "Continue.",
      toolCallId: "call_delegate_resume",
    });

    expect(runChildMessage).toHaveBeenCalledOnce();
  });

  it("reuses an incomplete assistant response for a retried user message", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_123",
      messages: [
        {
          id: "msg_assistant_1",
          sessionId: "ses_123",
          status: "running",
          responseToMessageId: "msg_user",
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_1",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(true);

    expect(db.state.messages).toHaveLength(1);
  });

  it("blocks hosted search fan-out after the per-message budget", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: "exa_req_123",
            searchType: "auto",
            costDollars: { total: 0.001 },
            results: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const budget = createHostedToolBudget();

    for (let index = 0; index < 8; index += 1) {
      await executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: agentConfig(),
        toolCallId: `call_exa_${index}`,
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
        args: { query: `test ${index}` },
        getSandbox: async () => {
          throw new Error("sandbox should not hydrate");
        },
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        toolBudget: budget,
      });
    }

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_exa_over_budget",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
      args: { query: "too many" },
      getSandbox: async () => {
        throw new Error("sandbox should not hydrate");
      },
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
      toolBudget: budget,
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(db.state.toolUsage).toHaveLength(8);
    expect(JSON.parse(db.state.messages.at(-1)?.content ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "tool_call_limit_exceeded", recoverable: true },
    });
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_exa_over_budget",
          name: "exa_search",
          error: expect.objectContaining({ code: "tool_call_limit_exceeded" }),
        }),
      }),
    );
  });

  it("returns recoverable sandbox path failures as tool results without hydrating E2B", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "README.md" },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        observabilityContext: {
          workspaceId: "wsp_123",
          userId: "user_123",
          agentId: "agt_123",
          modelProvider: "vercel-ai-gateway",
          modelName: "openai/gpt-5.4-mini",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_sandbox_path",
        recoverable: true,
      }),
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "read_file",
      toolCallId: "call_read",
    });
    expect(db.state.messages.at(-1)?.content).toContain("invalid_sandbox_path");
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_read",
          name: "read_file",
          error: expect.objectContaining({ code: "invalid_sandbox_path" }),
        }),
      }),
    );
    expect(observabilityMocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "opencompany.runner_tool_failed",
        session_id: "ses_123",
        tool_call_id: "call_read",
        tool_name: "read_file",
        tool_kind: "sandbox",
      }),
    );
    expect(braintrustMocks.logBraintrustCurrentSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          name: "RecoverableToolError",
          message: expect.stringContaining("Use paths prefixed with work/"),
        }),
        metadata: expect.objectContaining({
          session_id: "ses_123",
          message_id: "msg_assistant",
          tool_call_id: "call_read",
          tool_name: "read_file",
          tool_kind: "sandbox",
          model_name: "openai/gpt-5.4-mini",
        }),
      }),
    );
  });

  it("preflights edit_file paths before hydrating E2B", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_edit",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("edit_file") as RuntimeToolDefinition,
        args: {
          path: "README.md",
          instructions: "Edit a bare path.",
          edits: [{ oldString: "old", newString: "new" }],
        },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["edit_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_sandbox_path",
        recoverable: true,
      }),
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "edit_file",
      toolCallId: "call_edit",
    });
  });

  it("returns recoverable sandbox execution failures as tool results after hydration", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => ({
      sandboxId: "sbx_123",
      files: {
        read: vi.fn(async () => {
          throw new Error("File not found");
        }),
      },
    }));

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "work/missing.txt" },
        getSandbox: getSandbox as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        message: "File not found",
        code: "tool_execution_failed",
        recoverable: true,
      },
    });

    expect(getSandbox).toHaveBeenCalledTimes(1);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "read_file",
      toolCallId: "call_read",
    });
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_read",
          error: expect.objectContaining({ code: "tool_execution_failed" }),
        }),
      }),
    );
  });

  it("injects repo-scoped GitHub auth into bound shell commands and redacts it", async () => {
    githubMocks.getGitHubWorkInstallationToken.mockResolvedValue("github_token_123");
    const db = createLeaseDb({
      runLeaseId: "run_123",
      githubRows: [
        {
          integrationId: "wint_123",
          fullName: "opencompany/web",
          installationId: "install_123",
          connectionLabel: "opencompany",
          connectionStatus: "connected",
          connectionStatusReason: null,
          resourceStatus: "available",
          resourceStatusReason: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => ({
      sandboxId: "sbx_123",
      commands: {
        run: vi.fn(
          async (
            command: string,
            options: {
              envs?: Record<string, string>;
              onStdout?: (data: string) => void;
              onStderr?: (data: string) => void;
            },
          ) => {
            if (command.includes("find brain")) return { stdout: "", stderr: "", exitCode: 0 };
            options.onStdout?.(`stdout ${options.envs?.GH_TOKEN ?? "missing"}\n`);
            options.onStderr?.(`stderr ${options.envs?.GIT_CONFIG_VALUE_0 ?? "missing"}\n`);
            return {
              stdout: `done ${options.envs?.GH_TOKEN ?? "missing"}`,
              stderr: `err ${options.envs?.GIT_CONFIG_VALUE_0 ?? "missing"}`,
              exitCode: 0,
            };
          },
        ),
      },
    }));
    const config = agentConfig({
      tools: [
        {
          id: "amp",
          type: "coding_agent",
          provider: "amp",
          label: "AMP",
          description: "Delegate coding work to Amp inside an E2B sandbox.",
          prCapable: true,
        },
      ],
      integrations: {
        github: {
          repositories: [
            {
              id: "opencompany-web",
              fullName: "opencompany/web",
              defaultBranch: "main",
              binding: {
                provider: "github",
                externalId: "repo_123",
                resourceType: "repository",
                displayName: "opencompany/web",
                connection: {
                  externalId: "install_123",
                  label: "opencompany",
                  accountName: "opencompany",
                  accountType: "Organization",
                },
              },
            },
          ],
        },
      },
    });

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: config,
      toolCallId: "toolu/with spaces",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("shell") as RuntimeToolDefinition,
      args: { command: "cd work && gh pr list" },
      getSandbox: getSandbox as never,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["shell"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    const shellRun = (await getSandbox.mock.results[0]?.value).commands.run.mock.calls.find(
      ([command]: [string, unknown]) => command === "cd work && gh pr list",
    );
    expect(shellRun?.[1]).toMatchObject({
      envs: {
        GH_TOKEN: "github_token_123",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_REPO: "opencompany/web",
        GH_CONFIG_DIR: "/tmp/opencompany-gh-toolu-with-spaces",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: expect.stringMatching(/^Authorization: Basic /),
      },
    });
    expect(githubMocks.getGitHubWorkInstallationToken).toHaveBeenCalledWith({
      installationId: "install_123",
      repositoryFullNames: ["opencompany/web"],
    });
    expect(JSON.parse(db.state.messages.at(-1)?.content ?? "{}")).toEqual({
      stdout: "done [redacted]",
      stderr: "err [redacted]",
      exitCode: 0,
    });
    expect(publishTransientRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.output",
        payload: expect.objectContaining({
          delta: "stdout [redacted]\n",
        }),
      }),
    );
    expect(publishTransientRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.output",
        payload: expect.objectContaining({
          delta: "stderr [redacted]\n",
        }),
      }),
    );
  });

  it("leaves shell unauthenticated when no explicit repository binding exists", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const commands = {
      run: vi.fn(async (command: string, options: { envs?: Record<string, string> }) => {
        if (command.includes("find brain")) return { stdout: "", stderr: "", exitCode: 0 };
        return {
          stdout: options.envs?.GH_TOKEN ?? "no-token",
          stderr: "",
          exitCode: 0,
        };
      }),
    };
    const getSandbox = vi.fn(async () => ({ sandboxId: "sbx_123", commands }));

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_shell",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("shell") as RuntimeToolDefinition,
      args: { command: "env" },
      getSandbox: getSandbox as never,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["shell"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    const shellRun = commands.run.mock.calls.find(([command]) => command === "env");
    expect(shellRun?.[1]).not.toHaveProperty("envs");
    expect(githubMocks.getGitHubWorkInstallationToken).not.toHaveBeenCalled();
    expect(JSON.parse(db.state.messages.at(-1)?.content ?? "{}")).toMatchObject({
      stdout: "no-token",
      exitCode: 0,
    });
  });

  it("returns GitHub integration failures as recoverable shell results", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_123",
      githubRows: [
        {
          integrationId: "wint_123",
          fullName: "opencompany/web",
          installationId: "install_123",
          connectionLabel: "opencompany",
          connectionStatus: "needs_reauth",
          connectionStatusReason: "Installation token failed with 401.",
          resourceStatus: "available",
          resourceStatusReason: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const commands = {
      run: vi.fn(async (command: string) =>
        command.includes("find brain") ? { stdout: "", stderr: "", exitCode: 0 } : null,
      ),
    };
    const getSandbox = vi.fn(async () => ({ sandboxId: "sbx_123", commands }));
    const config = agentConfig({
      tools: [
        {
          id: "amp",
          type: "coding_agent",
          provider: "amp",
          label: "AMP",
          description: "Delegate coding work to Amp inside an E2B sandbox.",
          prCapable: true,
        },
      ],
      integrations: {
        github: {
          repositories: [
            { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
          ],
        },
      },
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: config,
        toolCallId: "call_shell",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("shell") as RuntimeToolDefinition,
        args: { command: "gh pr list" },
        getSandbox: getSandbox as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["shell"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "GitHub connection opencompany is needs reauth. Reconnect GitHub or update the agent repository mention. Installation token failed with 401.",
        code: "tool_execution_failed",
        recoverable: true,
      }),
    });

    expect(commands.run.mock.calls.some(([command]) => command === "gh pr list")).toBe(false);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "shell",
      toolCallId: "call_shell",
    });
  });

  it("keeps sandbox hydration failures fatal", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("E2B unavailable");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "work/file.txt" },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).rejects.toThrow("E2B unavailable");

    expect(db.state.messages).toHaveLength(0);
    expect(appendRuntimeEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "tool.failed" }),
    );
  });

  it("keeps aborted tool executions fatal", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const controller = new AbortController();
    controller.abort();
    const getSandbox = vi.fn(async () => ({
      sandboxId: "sbx_123",
    }));

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "work/file.txt" },
        getSandbox: getSandbox as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: controller.signal,
        checkAbort: async () => {},
      }),
    ).rejects.toThrow("Run aborted.");

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.messages).toHaveLength(0);
  });

  it("captures hosted Exa validation failures with searchable monitoring context", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: agentConfig(),
        toolCallId: "call_exa",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
        args: {
          query: "OpenAI leadership",
          category: "people",
          excludeDomains: ["example.com"],
          startPublishedDate: "2026-01-01",
        },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        observabilityContext: {
          workspaceId: "wsp_123",
          userId: "user_123",
          agentId: "agt_123",
          modelProvider: "vercel-ai-gateway",
          modelName: "openai/gpt-5.4-mini",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "tool_execution_failed",
        recoverable: true,
      }),
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(observabilityMocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "opencompany.runner_tool_failed",
        workspace_id: "wsp_123",
        user_id: "user_123",
        agent_id: "agt_123",
        session_id: "ses_123",
        message_id: "msg_assistant",
        tool_call_id: "call_exa",
        tool_name: "exa_search",
        tool_kind: "hosted",
        model_provider: "vercel-ai-gateway",
        model_name: "openai/gpt-5.4-mini",
        hosted_provider: "exa",
        hosted_operation: "search",
        tool_error_stage: "request_validation",
        tool_error_code: "exa_unsupported_category_filter_combination",
        exa_category: "people",
        exa_has_exclude_domains: true,
        exa_has_published_date_filter: true,
      }),
    );
    expect(db.state.toolUsage).toHaveLength(0);
    expect(db.state.messages).toHaveLength(1);
    expect(db.state.messages[0]).toMatchObject({
      role: "tool",
      toolName: "exa_search",
      toolCallId: "call_exa",
    });
  });
});

describe("stream error handling", () => {
  it("records terminal stream metadata from finish-step parts", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    async function* stream() {
      yield { type: "text-delta", text: "Working" } as never;
      yield {
        type: "finish-step",
        finishReason: "tool-calls",
        rawFinishReason: "tool_calls",
        response: {
          id: "response_123",
          timestamp: new Date("2026-05-22T12:00:00.000Z"),
          modelId: "openai/gpt-5.4-mini",
        },
        usage: usage(100, 20),
      } as never;
    }

    const result = await collectAssistantStream({
      stream: stream(),
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      exposeReasoningSummary: false,
      signal: new AbortController().signal,
      checkAbort: async () => {},
      toolStartCoordinator: createToolStartCoordinator(),
    });

    expect(result).toMatchObject({
      assistantContent: "Working",
      stepCount: 1,
      lastFinishReason: "tool-calls",
      lastRawFinishReason: "tool_calls",
      lastStepEndedWithToolCalls: true,
    });
  });

  it("persists pending text before tool starts even when tool input arrives first", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const toolStartCoordinator = createToolStartCoordinator();
    toolStartCoordinator.record({
      toolCallId: "call_search",
      name: "exa_search",
      input: { query: "YC agent discussion" },
    });

    async function* stream() {
      yield { type: "text-delta", text: "I'll search, then distill the" } as never;
      yield {
        type: "tool-call",
        toolCallId: "call_search",
        toolName: "exa_search",
        input: { query: "fallback input" },
      } as never;
      yield { type: "text-delta", text: " themes." } as never;
    }

    await collectAssistantStream({
      stream: stream(),
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      exposeReasoningSummary: false,
      signal: new AbortController().signal,
      checkAbort: async () => {},
      toolStartCoordinator,
    });

    const transientEvents = vi
      .mocked(publishTransientRuntimeEvent)
      .mock.calls.map((call) => call[0]);
    const durableEvents = vi.mocked(appendRuntimeEvent).mock.calls.map((call) => call[1]);
    expect(transientEvents.map((event) => event.type)).toEqual(["message.delta", "message.delta"]);
    expect(durableEvents.map((event) => event.type)).toEqual(["tool.started"]);
    expect(transientEvents[0]).toMatchObject({
      payload: { delta: "I'll search, then distill the" },
    });
    expect(durableEvents[0]).toMatchObject({
      payload: {
        toolCallId: "call_search",
        name: "exa_search",
        input: { query: "YC agent discussion" },
      },
    });
  });

  it("rejects turn completion when the model is still requesting tools at the step cap", () => {
    expect(() =>
      assertTurnComplete({
        assistantContent: "Partial progress.",
        assistantReplayParts: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "list_files",
            input: {},
          },
        ],
        lastStepEndedWithToolCalls: true,
        stepCount: MAX_MODEL_STEPS,
      }),
    ).toThrow(ToolStepLimitExceededError);
  });

  it("allows normal turns that end with final assistant text", () => {
    expect(() =>
      assertTurnComplete({
        assistantContent: "Done.",
        assistantReplayParts: [{ type: "text", text: "Done." }],
        lastStepEndedWithToolCalls: false,
        stepCount: 2,
      }),
    ).not.toThrow();
  });

  it("flags a tool-driven turn that stops after announcing an unexecuted action", () => {
    const result = detectIncompleteTurn({
      assistantContent:
        "I scanned the open PRs.\n\nNow let me check the files changed in each PR to assess complexity:",
      assistantReplayParts: [
        { type: "text", text: "I scanned the open PRs." },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "shell",
          input: { cmd: "gh pr list" },
        },
        {
          type: "text",
          text: "Now let me check the files changed in each PR to assess complexity:",
        },
      ],
      lastFinishReason: "stop",
      lastStepEndedWithToolCalls: false,
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toMatch(/never took/);
  });

  it("does not flag a genuine completion that used tools and ends with a real answer", () => {
    expect(
      detectIncompleteTurn({
        assistantContent: "Done — 3 PRs reviewed and the Slack notification was sent.",
        assistantReplayParts: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "slack_post",
            input: { text: "report" },
          },
          { type: "text", text: "Done — 3 PRs reviewed and the Slack notification was sent." },
        ],
        lastFinishReason: "stop",
        lastStepEndedWithToolCalls: false,
      }),
    ).toBeNull();
  });

  it("does not flag a colon-terminated reply when the turn never drove a tool", () => {
    expect(
      detectIncompleteTurn({
        assistantContent: "Here are the three options I'd consider:",
        assistantReplayParts: [{ type: "text", text: "Here are the three options I'd consider:" }],
        lastFinishReason: "stop",
        lastStepEndedWithToolCalls: false,
      }),
    ).toBeNull();
  });

  it("does not flag while the model is still requesting tools", () => {
    expect(
      detectIncompleteTurn({
        assistantContent: "Let me check the files changed:",
        assistantReplayParts: [
          { type: "text", text: "Let me check the files changed:" },
          { type: "tool-call", toolCallId: "call_1", toolName: "shell", input: {} },
        ],
        lastFinishReason: "tool-calls",
        lastStepEndedWithToolCalls: true,
      }),
    ).toBeNull();
  });

  it("throws model stream errors instead of allowing blank completions", () => {
    expect(() =>
      throwIfStreamErrorPart({ type: "error", error: new Error("gateway failed") } as never),
    ).toThrow("gateway failed");
  });

  it("throws tool stream errors with a fallback message", () => {
    expect(() =>
      throwIfStreamErrorPart({
        type: "tool-error",
        toolName: "list_files",
        toolCallId: "tool_123",
        input: {},
        error: null,
      } as never),
    ).toThrow("Tool list_files failed.");
  });
});

describe("Amp stream parsing", () => {
  it("starts a new Amp thread when no prior thread id is provided", () => {
    expect(buildAmpCommand({ task: "implement the change" })).toBe(
      "amp --dangerously-allow-all --mode smart -x 'implement the change'",
    );
  });

  it("allows Amp mode to be selected for harder tasks", () => {
    expect(buildAmpCommand({ task: "implement the change", mode: "deep" })).toBe(
      "amp --dangerously-allow-all --mode deep -x 'implement the change'",
    );
  });

  it("continues an existing Amp thread when a prior thread id is provided", () => {
    expect(
      buildAmpCommand({
        task: "address the follow-up",
        ampThreadId: "T-2775dc92-90ed-4f85-8b73-8f9766029e83",
        mode: "rush",
      }),
    ).toBe(
      "amp threads continue --dangerously-allow-all --mode rush -x 'address the follow-up' 'T-2775dc92-90ed-4f85-8b73-8f9766029e83'",
    );
  });

  it("rejects GitHub repositories whose parent connection needs reauthorization", async () => {
    const db = createGitHubWorkRepositoryDb([
      {
        integrationId: "wint_123",
        fullName: "opencompany/web",
        installationId: "12345",
        connectionLabel: "opencompany",
        connectionStatus: "needs_reauth",
        connectionStatusReason: "Installation token failed with 401.",
        resourceStatus: "available",
        resourceStatusReason: null,
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      loadGitHubWorkRepository("wks_123", {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      }),
    ).rejects.toThrow(
      "GitHub connection opencompany is needs reauth. Reconnect GitHub or update the agent repository mention. Installation token failed with 401.",
    );
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "needs_reauth",
        statusReason: "Installation token failed with 401.",
      }),
    );
  });

  it("rejects GitHub repositories with degraded resource status", async () => {
    const db = createGitHubWorkRepositoryDb([
      {
        integrationId: "wint_123",
        fullName: "opencompany/web",
        installationId: "12345",
        connectionLabel: "opencompany",
        connectionStatus: "connected",
        connectionStatusReason: null,
        resourceStatus: "permission_lost",
        resourceStatusReason: "Repository is no longer visible to the GitHub installation.",
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      loadGitHubWorkRepository("wks_123", {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      }),
    ).rejects.toThrow(
      "GitHub repository opencompany/web is no longer available to this workspace. Reconnect GitHub or update the agent repository mention. Repository is no longer visible to the GitHub installation.",
    );
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "sync_failed",
        statusReason: "Repository is no longer visible to the GitHub installation.",
      }),
    );
  });

  it("rejects ambiguous unbound GitHub repositories across multiple usable connections", async () => {
    const db = createGitHubWorkRepositoryDb([
      {
        integrationId: "wint_123",
        fullName: "opencompany/web",
        installationId: "12345",
        connectionLabel: "opencompany",
        connectionStatus: "connected",
        connectionStatusReason: null,
        resourceStatus: "available",
        resourceStatusReason: null,
      },
      {
        integrationId: "wint_456",
        fullName: "opencompany/web",
        installationId: "45678",
        connectionLabel: "opencompany-eu",
        connectionStatus: "connected",
        connectionStatusReason: null,
        resourceStatus: "available",
        resourceStatusReason: null,
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      loadGitHubWorkRepository("wks_123", {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      }),
    ).rejects.toThrow(
      "GitHub work repository opencompany/web matches multiple workspace connections. Re-save the agent with a concrete repository binding.",
    );
  });

  it("builds ephemeral GitHub auth env for Amp without putting tokens in the command", () => {
    const env = buildAmpCommandEnv({
      ampApiKey: "amp_secret_123",
      githubAuthHeader: "Authorization: Basic github_basic_secret",
      githubToken: "github_token_123",
      toolCallId: "toolu/with spaces",
    });

    expect(env).toMatchObject({
      AMP_API_KEY: "amp_secret_123",
      GH_TOKEN: "github_token_123",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_CONFIG_DIR: "/tmp/opencompany-gh-toolu-with-spaces",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic github_basic_secret",
    });
    expect(env).not.toHaveProperty("GH_REPO");
    expect(buildAmpCommand({ task: "open a pr" })).not.toContain("github_token_123");
  });

  it("adds GitHub default repo context when an env builder receives one", () => {
    const env = buildAmpCommandEnv({
      ampApiKey: "amp_secret_123",
      githubAuthHeader: "Authorization: Basic github_basic_secret",
      githubToken: "github_token_123",
      repositoryFullName: "opencompany/web",
      toolCallId: "toolu/with spaces",
    });

    expect(env).toMatchObject({
      GH_REPO: "opencompany/web",
      GH_TOKEN: "github_token_123",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    });
  });

  it("redacts known Amp and GitHub secrets from streamed or saved text", () => {
    const redact = createKnownSecretRedactor([
      "amp_secret_123",
      "github_token_123",
      "Authorization: Basic github_basic_secret",
    ]);

    expect(
      redact(
        "AMP=amp_secret_123 GH=github_token_123 header=Authorization: Basic github_basic_secret",
      ),
    ).toBe("AMP=[redacted] GH=[redacted] header=[redacted]");
  });

  it("publishes Amp's non-default branch when one exists", () => {
    expect(
      selectPublishBranch({
        currentBranch: "feature/from-amp",
        defaultBranch: "main",
        sessionId: "ses_845254899642482b9082",
        now: 123,
      }),
    ).toBe("feature/from-amp");
  });

  it("uses a generated branch instead of pushing the default branch", () => {
    expect(
      selectPublishBranch({
        currentBranch: "main",
        defaultBranch: "main",
        sessionId: "ses_845254899642482b9082",
        now: 123,
      }),
    ).toBe("opencompany/amp-482b9082-123");
  });

  it("captures the final successful Amp result across stdout chunks", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "T-123",
          tools: [],
          mcp_servers: [],
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "intermediate answer" }],
            stop_reason: "end_turn",
          },
          parent_tool_use_id: null,
          session_id: "T-123",
        }),
      ].join("\n"),
    );
    stream.push(
      `\n${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        is_error: false,
        num_turns: 1,
        result: "final answer",
        session_id: "T-123",
      }).slice(0, 80)}`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        is_error: false,
        num_turns: 1,
        result: "final answer",
        session_id: "T-123",
      }).slice(80)}\n`,
    );

    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-123",
      status: "success",
      result: "final answer",
      error: null,
      durationMs: 1200,
      numTurns: 1,
      permissionDenials: [],
      usage: null,
    });
  });

  it("falls back to the last assistant text when Amp omits result text", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "assistant fallback" }],
          stop_reason: "end_turn",
        },
        parent_tool_use_id: null,
        session_id: "T-456",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 900,
        is_error: false,
        num_turns: 1,
        result: "",
        session_id: "T-456",
      })}\n`,
    );

    stream.finish();

    expect(stream.summary()).toMatchObject({
      threadId: "T-456",
      status: "success",
      result: "assistant fallback",
      error: null,
    });
  });

  it("captures plain Amp output when JSON streaming is not requested", () => {
    const stream = createAmpStreamAccumulator();

    stream.push("\u001b[?25hWorking on it...\n");
    stream.push("Done with the implementation.\n");

    expect(stream.summary({ exitCode: 0 })).toMatchObject({
      threadId: null,
      status: "success",
      result: "Working on it...\nDone with the implementation.",
      error: null,
    });
  });

  it("captures Amp execution errors as structured output", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 300,
        is_error: true,
        num_turns: 1,
        error: "permission denied",
        session_id: "T-789",
        permission_denials: ["Bash rm -rf"],
      })}\n`,
    );
    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-789",
      status: "error",
      result: "",
      error: "permission denied",
      durationMs: 300,
      numTurns: 1,
      permissionDenials: ["Bash rm -rf"],
      usage: null,
    });
  });

  it("accumulates usage from multiple assistant events", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
        },
        session_id: "T-usage-1",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 10,
          },
        },
        session_id: "T-usage-1",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 500,
        is_error: false,
        num_turns: 2,
        result: "done",
        session_id: "T-usage-1",
      })}\n`,
    );
    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-usage-1",
      status: "success",
      result: "done",
      error: null,
      durationMs: 500,
      numTurns: 2,
      permissionDenials: [],
      usage: {
        input_tokens: 300,
        output_tokens: 130,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 30,
      },
    });
  });

  it("prefers result event usage over accumulated sum", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "step" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: "T-usage-2",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 400,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-2",
        usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 80 },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-usage-2",
      status: "success",
      result: "done",
      error: null,
      durationMs: 400,
      numTurns: 1,
      permissionDenials: [],
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_read_input_tokens: 80,
      },
    });
  });

  it("returns usage null when no usage data is present", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "no usage" }],
        },
        session_id: "T-usage-3",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 100,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: "T-usage-3",
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toBeNull();
  });

  it("falls back to accumulated usage when the result event reports zero tokens", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "step" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: "T-usage-zero-result",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 200,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-zero-result",
        usage: { input_tokens: 0, output_tokens: 0 },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it("preserves cache token counts when result event reports zero tokens but has cache fields", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "step" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: "T-usage-cache-zero",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 200,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-cache-zero",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 200,
        },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 200,
    });
  });

  it("accepts result event whose usage carries only cache fields", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 150,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-cache-only",
        usage: { cache_read_input_tokens: 800 },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 800,
    });
  });

  it("accumulates assistant events whose usage carries only cache fields", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "cached step" }],
          usage: { cache_read_input_tokens: 1234 },
        },
        session_id: "T-usage-assistant-cache-only",
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1234,
    });
  });

  it("formats Amp stream activity without leaking partial JSON chunks", () => {
    const formatter = createAmpActivityFormatter();
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun test apps/runner/src/agent-loop.test.ts" },
          },
        ],
      },
      session_id: "T-123",
    });

    expect(formatter.push(`${assistantEvent.slice(0, 40)}`)).toBe("");
    expect(formatter.push(`${assistantEvent.slice(40)}\n`)).toBe(
      'Amp is using Bash: {"command":"bun test apps/runner/src/agent-loop.test.ts"}.\n',
    );
  });

  it("summarizes Amp session lifecycle and final result events", () => {
    const formatter = createAmpActivityFormatter();

    const output = formatter.push(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "T-123",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          duration_ms: 1250,
          num_turns: 2,
          is_error: false,
          result: "Done",
          session_id: "T-123",
        }),
      ].join("\n") + "\n",
    );

    expect(output).toBe("Amp session T-123 started.\nAmp completed in 1.3s, 2 turns.\n");
  });
});

describe("reasoning stream helpers", () => {
  it("reads reasoning parts without treating them as assistant text", () => {
    expect(readReasoningTextDelta({ type: "reasoning", text: "Reviewed constraints." })).toBe(
      "Reviewed constraints.",
    );
    expect(readReasoningTextDelta({ type: "reasoning-delta", delta: "Checked files." })).toBe(
      "Checked files.",
    );
    expect(readReasoningTextDelta({ type: "text-delta", text: "Visible answer." })).toBe("");
  });

  it("normalizes empty and repeated-newline reasoning summaries", () => {
    expect(normalizeReasoningSummary("")).toBe("");
    expect(normalizeReasoningSummary("  A\n\n\n\nB  ")).toBe("A\n\nB");
  });
});

type MessageState = {
  id: string;
  sessionId: string;
  role?: string;
  content?: string;
  status?: string;
  responseToMessageId?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
};

type UsageState = {
  id: number;
  stepIndex: number;
};

type ToolUsageState = {
  id: number;
  toolCallId: string;
  toolName: string;
  provider: string;
  operation: string;
  providerRequestId?: string | null;
  costUsdMicros: number;
};

type DelegationSessionState = {
  id: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  status: string;
  source?: string;
  parentSessionId?: string | null;
  parentMessageId?: string | null;
  parentToolCallId?: string | null;
  runLeaseId?: string | null;
  archivedAt?: Date | null;
};

type LeaseDbState = {
  session: {
    id: string;
    archivedAt: Date | null;
    runLeaseId: string | null;
    runLeaseOwner: string | null;
  };
  messages: MessageState[];
  usage: UsageState[];
  toolUsage: ToolUsageState[];
};

// In-memory `LeaseWriteStore` that mirrors the atomic SQL semantics against the fake
// db's `state`: a write lands only while the lease still matches the session row, and
// it distinguishes "lease lost" from the idempotent "assistant already exists" path —
// exactly what the database statements enforce.
function createStateLeaseWriteStore(getState: () => LeaseDbState): LeaseWriteStore {
  const leaseCurrent = (lease: { leaseId: string; leaseOwner: string }) => {
    const { session } = getState();
    return Boolean(
      session &&
        !session.archivedAt &&
        session.runLeaseId === lease.leaseId &&
        session.runLeaseOwner === lease.leaseOwner,
    );
  };

  return {
    async insertAssistantMessage(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { messages } = getState();
      if (
        input.responseToMessageId &&
        messages.some((message) => message.responseToMessageId === input.responseToMessageId)
      ) {
        return "conflict";
      }
      messages.push({
        id: input.id,
        sessionId: input.sessionId,
        role: "assistant",
        status: "running",
        responseToMessageId: input.responseToMessageId,
      });
      return "inserted";
    },
    async findResponseMessage(sessionId, responseToMessageId) {
      const message = getState().messages.find(
        (item) => item.sessionId === sessionId && item.responseToMessageId === responseToMessageId,
      );
      return message ? { id: message.id, status: message.status ?? "running" } : null;
    },
    async completeAssistantMessage(input, lease) {
      if (!leaseCurrent(lease)) return false;
      const message = getState().messages.find(
        (item) => item.id === input.assistantMessageId && item.sessionId === input.sessionId,
      );
      if (!message) return false;
      Object.assign(message, { status: "completed", content: input.content });
      return true;
    },
    async insertToolMessage(input, lease) {
      if (!leaseCurrent(lease)) return false;
      getState().messages.push({
        id: input.id,
        sessionId: input.sessionId,
        role: "tool",
        status: "completed",
        content: input.content,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
      });
      return true;
    },
    async insertModelUsage(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { usage } = getState();
      const row = { id: usage.length + 1, ...input } as UsageState;
      usage.push(row);
      return { id: row.id };
    },
    async insertToolUsage(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { toolUsage } = getState();
      const row = { id: toolUsage.length + 1, ...input } as ToolUsageState;
      toolUsage.push(row);
      return { id: row.id };
    },
  };
}

function createLeaseDb(input: {
  runLeaseId?: string | null;
  runLeaseExpiresAt?: Date | null;
  messages?: MessageState[];
  githubRows?: unknown[];
}) {
  const state = {
    session: {
      id: "ses_123",
      archivedAt: null as Date | null,
      runLeaseId: input.runLeaseId ?? null,
      runLeaseOwner: input.runLeaseId ? "runner-test" : null,
      runLeaseMessageId: null as string | null,
      runLeaseExpiresAt: input.runLeaseExpiresAt ?? null,
    },
    messages: [...(input.messages ?? [])],
    usage: [] as UsageState[],
    toolUsage: [] as ToolUsageState[],
    ledgerDebits: 0,
  };

  return {
    state,
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                async returning() {
                  if (table === agentSessions) {
                    if (typeof values.runLeaseId === "string") {
                      const expiresAt = state.session.runLeaseExpiresAt;
                      const canAcquire =
                        !state.session.archivedAt &&
                        (!state.session.runLeaseId || (expiresAt && expiresAt <= new Date()));
                      if (!canAcquire) return [];
                      Object.assign(state.session, values);
                      return [{ id: state.session.id, leaseId: state.session.runLeaseId }];
                    }

                    Object.assign(state.session, values);
                    return [{ id: state.session.id }];
                  }

                  if (table === agentSessionMessages) {
                    const message = state.messages.find(
                      (item) => item.id === values.id || item.id === "msg_assistant",
                    );
                    if (!message) return [];
                    Object.assign(message, values);
                    return [{ id: message.id }];
                  }

                  return [];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          const query = {
            innerJoin() {
              return query;
            },
            where() {
              return query;
            },
            async limit() {
              if (table === agentSessions && state.session.runLeaseId === "run_123") {
                return [{ id: state.session.id }];
              }
              if (table === agentSessions && state.session.runLeaseId === "run_current") {
                return [];
              }
              if (table === agentSessions) return [{ id: state.session.id }];
              if (table === agentSessionMessages) {
                return state.messages
                  .filter((message) => message.responseToMessageId)
                  .map((message) => ({
                    id: message.id,
                    status: message.status ?? "running",
                  }))
                  .slice(0, 1);
              }
              return input.githubRows ?? [];
            },
          };
          return query;
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessionUsage) {
            const row = { id: state.usage.length + 1, ...values } as UsageState;
            state.usage.push(row);
            return {
              async returning() {
                return [{ id: row.id }];
              },
            };
          }
          if (table === agentSessionToolUsage) {
            const row = { id: state.toolUsage.length + 1, ...values } as ToolUsageState;
            state.toolUsage.push(row);
            return {
              async returning() {
                return [{ id: row.id }];
              },
            };
          }

          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  if (table !== agentSessionMessages) return [];
                  if (
                    state.messages.some(
                      (message) => message.responseToMessageId === values.responseToMessageId,
                    )
                  ) {
                    return [];
                  }
                  state.messages.push(values as MessageState);
                  return [{ id: values.id }];
                },
              };
            },
            async returning() {
              state.messages.push(values as MessageState);
              return [{ id: values.id }];
            },
          };
        },
      };
    },
    async execute() {
      state.ledgerDebits += 1;
      return { rows: [{ ledgerId: state.ledgerDebits, balanceUsdMicros: 100_000 }] };
    },
  };
}

function createDelegationDb(
  input: { sessions?: DelegationSessionState[]; rollupRow?: Record<string, unknown> } = {},
) {
  const state = {
    agent: {
      id: "agt_research",
      name: "Research",
      path: "agents/research/research.agent",
      config: {
        ...agentConfig(),
        title: "Research",
        agents: [],
      },
    },
    sessions: [...(input.sessions ?? [])],
    messages: [] as MessageState[],
    events: [] as Array<{ sessionId?: string; type?: string; payload?: unknown }>,
    rollupRow: input.rollupRow ?? defaultDelegationRollupRow(),
  };
  let executeCount = 0;

  const db = {
    state,
    select() {
      const query = {
        table: undefined as unknown,
        from(table: unknown) {
          query.table = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        async limit() {
          if (query.table === agents) {
            return [state.agent];
          }
          if (query.table === agentSessions) {
            const session =
              state.sessions.find((item) => item.runLeaseId === "run_parent") ??
              state.sessions.at(0);
            if (!session) return [];
            return [
              {
                ...session,
                agentName: state.agent.name,
                agentPath: state.agent.path,
                source: session.source ?? "agent",
              },
            ];
          }
          if (query.table === agentSessionMessages) {
            const assistant = [...state.messages]
              .reverse()
              .find((message) => message.role === "assistant" && message.responseToMessageId);
            return assistant
              ? [
                  {
                    id: assistant.id,
                    status: assistant.status ?? "completed",
                    content: assistant.content ?? "",
                  },
                ]
              : [];
          }
          return [];
        },
      };
      return query;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessions) {
            state.sessions.push({
              id: values.id as string,
              workspaceId: values.workspaceId as string,
              userId: values.userId as string,
              agentId: values.agentId as string,
              status: (values.status as string | undefined) ?? "created",
              source: (values.source as string | undefined) ?? "user",
              parentSessionId: (values.parentSessionId as string | null | undefined) ?? null,
              parentMessageId: (values.parentMessageId as string | null | undefined) ?? null,
              parentToolCallId: (values.parentToolCallId as string | null | undefined) ?? null,
              runLeaseId: null,
              archivedAt: null,
            });
          }
          if (table === agentSessionMessages) {
            state.messages.push(values as MessageState);
          }
          if (table === agentSessionEvents) {
            state.events.push(values);
          }
          return {};
        },
      };
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(db);
    },
    async execute() {
      executeCount += 1;
      if (executeCount % 2 === 0) {
        return {
          rows: state.events
            .filter(
              (event) =>
                event.sessionId === "ses_parent" && event.type === "session.delegated_usage",
            )
            .map((event) => ({ payload: event.payload })),
        };
      }
      return {
        rows: [state.rollupRow],
      };
    },
  };

  return db;
}

function defaultDelegationRollupRow() {
  return {
    inputTokens: 0,
    inputNoCacheTokens: 0,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
    outputTextTokens: 0,
    outputReasoningTokens: 0,
    totalTokens: 0,
    providerCostUsdMicros: 0,
    platformFeeUsdMicros: 0,
    totalCostUsdMicros: 0,
    modelCostUsdMicros: 0,
    toolCostUsdMicros: 0,
    toolUsageTotalCostUsdMicros: 0,
    toolUsageByProviderOperation: [],
  };
}

function createGitHubWorkRepositoryDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  return {
    select: vi.fn(() => query),
    update: vi.fn(() => ({ set: updateSet })),
    updateSet,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "vag",
    exaApiKey: "exa_test",
    xApiBearerToken: "x_test",
    ampApiKey: "amp_test",
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-test",
    ...overrides,
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = baseAgentConfig();
  return {
    ...base,
    ...overrides,
  };
}

function baseAgentConfig(): AgentConfig {
  return {
    schemaVersion: "agent.v1" as const,
    title: "Test agent",
    instructions: "Test.",
    model: {
      provider: "vercel-ai-gateway" as const,
      name: "openai/gpt-5.4-mini" as const,
    },
    tools: [],
    brain: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  };
}
