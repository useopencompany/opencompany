import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDelegationDb,
  createStateLeaseWriteStore,
  env,
  type LeaseDbState,
} from "./agent-loop-test-support";
import { createAgentDelegationHandler } from "./delegation";
import { appendRuntimeEvent } from "./events";
import { setLeaseWriteStoreForTests } from "./lease-writes";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
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

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("@opencompany/observability/braintrust", () => braintrustMocks);

vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
  publishTransientRuntimeEvent: vi.fn((event) => ({ ...event, id: null, transient: true })),
}));

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

describe("agent delegation", () => {
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
});
