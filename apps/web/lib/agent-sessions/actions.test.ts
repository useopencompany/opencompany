import { newAgentSessionId, newAgentSessionMessageId } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchAgentAfterSessionCheck,
  dispatchAgentSessionStarted,
} from "@/lib/agent-sessions/events";
import {
  triggerAgentApprovalResume,
  triggerAgentMessageRun,
} from "@/lib/agent-sessions/message-runner";
import { TOOL_STEP_LIMIT_EXCEEDED_MESSAGE } from "@/lib/agent-sessions/resumable";
import { currentWorkspace } from "@/lib/auth";
import {
  continueInterruptedSession,
  createAgentSession,
  createAgentSessionFromPrompt,
  resolveToolApproval,
  setSessionStar,
  submitAgentSessionMessage,
} from "./actions";

vi.mock(import("@opencompany/agent-runtime"), async (importOriginal) => {
  const actual = await importOriginal();
  // Keep the pure attachment helpers (catalog lookup, MIME/size validation, limit) real so
  // server-side re-validation is exercised against the actual rules; only the id factories
  // are stubbed so tests can assert on deterministic ids.
  return {
    ...actual,
    newAgentSessionId: vi.fn(),
    newAgentSessionMessageId: vi.fn(),
  };
});

vi.mock("@opencompany/billing", () => ({
  hasPositiveWorkspaceBalance: vi.fn(),
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    void callback();
  },
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

// data.ts is intentionally NOT mocked: buildCreatedSessionDetail (a pure synthesizer) is
// exercised for real so these tests cover the actual create-session detail payload.

vi.mock("@/lib/agent-sessions/durable-streams", () => ({
  appendSessionStreamEvent: vi.fn().mockResolvedValue(undefined),
  closeSessionStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/events", () => ({
  dispatchAgentAfterSessionCheck: vi.fn().mockResolvedValue(undefined),
  dispatchAgentSessionStarted: vi.fn().mockResolvedValue(undefined),
  dispatchAgentSessionAbortRequested: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/message-runner", () => ({
  triggerAgentApprovalResume: vi.fn().mockResolvedValue(undefined),
  triggerAgentMessageRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/runner", () => ({
  callRunner: vi.fn(),
  getRunnerPublicUrl: vi.fn().mockReturnValue(null),
}));

const currentWorkspaceMock = vi.mocked(currentWorkspace);
const hasPositiveWorkspaceBalanceMock = vi.mocked(hasPositiveWorkspaceBalance);
const getDbMock = vi.mocked(getDb);
const newAgentSessionIdMock = vi.mocked(newAgentSessionId);
const newAgentSessionMessageIdMock = vi.mocked(newAgentSessionMessageId);
const dispatchAgentAfterSessionCheckMock = vi.mocked(dispatchAgentAfterSessionCheck);
const dispatchAgentSessionStartedMock = vi.mocked(dispatchAgentSessionStarted);
const triggerAgentApprovalResumeMock = vi.mocked(triggerAgentApprovalResume);
const triggerAgentMessageRunMock = vi.mocked(triggerAgentMessageRun);
const captureServerEventMock = vi.mocked(captureServerEvent);

function fakeAgent() {
  return {
    id: "agt_123",
    name: "Leo",
    path: "agents/leo/leo.agent",
    workspaceId: "wks_123",
    config: { model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" } },
  };
}

const CREATED_AT = new Date("2026-06-04T10:00:00.000Z");

function fakeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_123",
    workspaceId: "wks_123",
    userId: "usr_123",
    agentId: "agt_123",
    title: "Ship it",
    status: "created",
    source: "user",
    modelProvider: "vercel-ai-gateway",
    modelName: "openai/gpt-5.4-mini",
    parentSessionId: null,
    parentMessageId: null,
    parentToolCallId: null,
    e2bSandboxId: null,
    workdir: "/home/user/workspace",
    runLeaseId: null,
    runLeaseOwner: null,
    runLeaseMessageId: null,
    runLeaseExpiresAt: null,
    runHeartbeatAt: null,
    abortRequestedAt: null,
    lastError: null,
    archivedAt: null,
    sandboxTerminatedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function fakeMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_123",
    sessionId: "ses_123",
    role: "user",
    status: "completed",
    content: "Ship it",
    internal: false,
    modelMessage: { role: "user", content: "Ship it" },
    toolName: null,
    toolCallId: null,
    responseToMessageId: null,
    createdAt: CREATED_AT,
    completedAt: CREATED_AT,
    ...overrides,
  };
}

const statusEventRow = {
  id: 1,
  type: "session.status",
  messageId: null,
  payload: { status: "created", message: "Session created" },
  createdAt: CREATED_AT,
};

function dbWithAgent(agent: ReturnType<typeof fakeAgent> | null) {
  const limit = vi.fn().mockResolvedValue(agent ? [agent] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(() => ({}));
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  // insertAgentSession reads back [sessionRow, statusEvent]; insertUserMessage (only on
  // the prompt path) reads back [messageRow, createdEvent]. Both go through db.batch and
  // synthesize the detail payload from these rows.
  const batch = vi
    .fn()
    .mockResolvedValueOnce([[fakeSessionRow()], [statusEventRow]])
    .mockResolvedValueOnce([[fakeMessageRow()], [{ id: 2, createdAt: CREATED_AT }]]);
  return { select, insert, batch } as never;
}

describe("createAgentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(true);
    newAgentSessionIdMock.mockReturnValue("ses_123");
    newAgentSessionMessageIdMock.mockReturnValue("msg_123");
  });

  it("returns a billing redirect when the workspace has no credit", async () => {
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(false);

    const result = await createAgentSession("agt_123");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/settings?billing=insufficient",
    });
    expect(getDbMock).toHaveBeenCalled();
    expect(dispatchAgentSessionStartedMock).not.toHaveBeenCalled();
  });

  it("returns an error when the agent cannot be found", async () => {
    getDbMock.mockReturnValue(dbWithAgent(null));

    const result = await createAgentSession("agt_missing");

    expect(result).toEqual({ ok: false, error: "Agent not found." });
    expect(dispatchAgentSessionStartedMock).not.toHaveBeenCalled();
  });

  it("synthesizes the session detail and sidebar projection on success", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));

    const result = await createAgentSession("agt_123");

    if (!result.ok) throw new Error("expected ok result");
    // The detail is synthesized from the just-written rows — no follow-up read.
    expect(result.detail.session).toMatchObject({
      id: "ses_123",
      agentId: "agt_123",
      agentName: "Leo",
      agentPath: "agents/leo/leo.agent",
      status: "created",
      source: "user",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      createdAt: CREATED_AT.toISOString(),
    });
    // A freshly created agent session (no prompt) has no messages and a single status event.
    expect(result.detail.messages).toEqual([]);
    expect(result.detail.events).toHaveLength(1);
    expect(result.detail.events[0]).toMatchObject({ type: "session.status" });
    expect(result.session).toEqual({
      id: "ses_123",
      title: "Ship it",
      status: "created",
      modelName: "openai/gpt-5.4-mini",
      lastError: null,
      createdAt: CREATED_AT.toISOString(),
      updatedAt: CREATED_AT.toISOString(),
      starredAt: null,
      unseen: false,
    });
    expect(dispatchAgentSessionStartedMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      workspaceId: "wks_123",
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("session_started", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      source: "agent",
    });
  });
});

describe("createAgentSessionFromPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(true);
    newAgentSessionIdMock.mockReturnValue("ses_123");
    newAgentSessionMessageIdMock.mockReturnValue("msg_123");
  });

  it("rejects empty messages without touching the database", async () => {
    const result = await createAgentSessionFromPrompt("agt_123", "   ");

    expect(result).toEqual({ ok: false, error: "Message is required." });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("returns a billing redirect when the workspace has no credit", async () => {
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(false);

    const result = await createAgentSessionFromPrompt("agt_123", "Hello");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/settings?billing=insufficient",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("returns an error when the agent cannot be found", async () => {
    getDbMock.mockReturnValue(dbWithAgent(null));

    const result = await createAgentSessionFromPrompt("agt_missing", "Hello");

    expect(result).toEqual({ ok: false, error: "Agent not found." });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("synthesizes the session detail with the user message and triggers the runner", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));

    const result = await createAgentSessionFromPrompt("agt_123", "Ship it");

    if (!result.ok) throw new Error("expected ok result");
    expect(result.session).toMatchObject({ id: "ses_123", status: "created" });
    // The prompt's user message is carried in the synthesized detail (instant paint on
    // the destination route) alongside the status + message.created events.
    expect(result.detail.messages).toEqual([
      expect.objectContaining({ id: "msg_123", role: "user", content: "Ship it" }),
    ]);
    expect(result.detail.events.map((event) => event.type)).toEqual([
      "session.status",
      "message.created",
    ]);
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      workspaceId: "wks_123",
    });
    expect(dispatchAgentAfterSessionCheckMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      workspaceId: "wks_123",
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("session_started", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      source: "prompt",
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("session_message_sent", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      message_id: "msg_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      is_initial_message: true,
      message_length: "Ship it".length,
    });
  });
});

describe("setSessionStar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  function dbForStar(session: { id: string } | null) {
    const limit = vi.fn().mockResolvedValue(session ? [session] : []);
    const selectWhere = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));
    const onConflictDoUpdate = vi.fn(() => ({}));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const deleteWhere = vi.fn(() => ({}));
    const del = vi.fn(() => ({ where: deleteWhere }));
    // batchWithTxid runs the write + a pg_current_xact_id() SELECT in one batch.
    const execute = vi.fn(() => ({}));
    const batch = vi.fn().mockResolvedValue([undefined, [{ txid: "4242" }]]);
    return {
      db: { select, insert, delete: del, execute, batch } as never,
      values,
      onConflictDoUpdate,
      del,
      deleteWhere,
    };
  }

  it("rejects starring a session the user cannot see", async () => {
    getDbMock.mockReturnValue(dbForStar(null).db);

    const result = await setSessionStar("ses_missing", true);

    expect(result).toEqual({ ok: false, error: "Session not found." });
  });

  it("upserts a star row and returns the new starredAt", async () => {
    const { db, values, onConflictDoUpdate, del } = dbForStar({ id: "ses_123" });
    getDbMock.mockReturnValue(db);

    const result = await setSessionStar("ses_123", true);

    expect(result.ok).toBe(true);
    expect(result.ok && typeof result.starredAt === "string").toBe(true);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "usr_123", sessionId: "ses_123" }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the star row when unstarring", async () => {
    const { db, del, deleteWhere, values } = dbForStar({ id: "ses_123" });
    getDbMock.mockReturnValue(db);

    const result = await setSessionStar("ses_123", false);

    expect(result).toEqual({ ok: true, txid: 4242, starredAt: null });
    expect(del).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });
});

describe("submitAgentSessionMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(true);
    newAgentSessionMessageIdMock.mockReturnValue("msg_456");
  });

  it("captures a message-sent event when a user submits a follow-up message", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: "ses_123",
        agentId: "agt_123",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    // insertUserMessage reads back [messageRow, createdEvent] from .returning().
    const returning = vi.fn(() => ({}));
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const batch = vi
      .fn()
      .mockResolvedValue([
        [{ id: "msg_456" }],
        [{ id: 1, createdAt: new Date("2026-06-04T10:00:00.000Z") }],
      ]);
    // submitAgentSessionMessage supersedes any pending ask_user_question via an UPDATE.
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
    getDbMock.mockReturnValue({ select, insert, batch, update } as never);

    const result = await submitAgentSessionMessage("ses_123", " Follow up ");

    expect(result).toEqual({ ok: true, messageId: "msg_456" });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_456",
      workspaceId: "wks_123",
    });
    expect(dispatchAgentAfterSessionCheckMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_456",
      workspaceId: "wks_123",
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("session_message_sent", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      message_id: "msg_456",
      is_initial_message: false,
      message_length: "Follow up".length,
    });
  });

  it("reports missing credits before session existence", async () => {
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(false);
    // Session lookup runs concurrently with the balance check, so it must still resolve.
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    getDbMock.mockReturnValue({ select } as never);

    const result = await submitAgentSessionMessage("ses_123", "Hi");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to continue this session.",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("rejects a message for a session the user cannot access", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    getDbMock.mockReturnValue({ select } as never);

    const result = await submitAgentSessionMessage("ses_123", "Hi");

    expect(result).toEqual({ ok: false, error: "Session not found." });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });
});

describe("continueInterruptedSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(true);
    newAgentSessionMessageIdMock.mockReturnValue("msg_continue");
  });

  function dbForContinue(session: Record<string, unknown> | null) {
    const limit = vi.fn().mockResolvedValue(session ? [session] : []);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const returning = vi.fn(() => ({}));
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const batch = vi
      .fn()
      .mockResolvedValue([
        [{ id: "msg_continue" }],
        [{ id: 9, createdAt: new Date("2026-06-04T10:00:00.000Z") }],
      ]);
    return { db: { select, insert, batch } as never, values };
  }

  const interruptedSession = {
    id: "ses_123",
    agentId: "agt_123",
    status: "interrupted",
    runLeaseId: null,
    lastError: null,
    modelProvider: "vercel-ai-gateway",
    modelName: "openai/gpt-5.4-mini",
  };

  it("rejects inaccessible or archived sessions through the session lookup", async () => {
    const { db } = dbForContinue(null);
    getDbMock.mockReturnValue(db);

    const result = await continueInterruptedSession("ses_123");

    expect(result).toEqual({ ok: false, error: "Session not found." });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("rejects non-interrupted sessions and sessions with an active lease", async () => {
    const { db: nonInterruptedDb } = dbForContinue({
      ...interruptedSession,
      status: "completed",
    });
    getDbMock.mockReturnValue(nonInterruptedDb);

    await expect(continueInterruptedSession("ses_123")).resolves.toEqual({
      ok: false,
      error: "This session is not interrupted.",
    });

    const { db: activeLeaseDb } = dbForContinue({
      ...interruptedSession,
      runLeaseId: "run_active",
    });
    getDbMock.mockReturnValue(activeLeaseDb);

    await expect(continueInterruptedSession("ses_123")).resolves.toEqual({
      ok: false,
      error: "This session is still running. Try again shortly.",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("rejects no-balance workspaces before dispatching work", async () => {
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(false);
    const { db } = dbForContinue(interruptedSession);
    getDbMock.mockReturnValue(db);

    const result = await continueInterruptedSession("ses_123");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to continue this session.",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("inserts a visible Continue message and dispatches runner work", async () => {
    const { db, values } = dbForContinue(interruptedSession);
    getDbMock.mockReturnValue(db);

    const result = await continueInterruptedSession("ses_123");

    expect(result).toEqual({ ok: true, messageId: "msg_continue" });
    const insertedMessage = values.mock.calls[0]?.[0];
    expect(insertedMessage).toMatchObject({
      id: "msg_continue",
      content: "Continue",
      modelMessage: {
        role: "user",
        content: expect.stringContaining("prior runner process was stopped"),
      },
    });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_continue",
      workspaceId: "wks_123",
    });
    expect(dispatchAgentAfterSessionCheckMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_continue",
      workspaceId: "wks_123",
    });
  });

  it("continues failed sessions that stopped at the tool-step limit", async () => {
    const { db, values } = dbForContinue({
      ...interruptedSession,
      status: "failed",
      lastError: TOOL_STEP_LIMIT_EXCEEDED_MESSAGE,
    });
    getDbMock.mockReturnValue(db);

    const result = await continueInterruptedSession("ses_123");

    expect(result).toEqual({ ok: true, messageId: "msg_continue" });
    const insertedMessage = values.mock.calls[0]?.[0];
    expect(insertedMessage).toMatchObject({
      content: "Continue",
      modelMessage: {
        role: "user",
        content: expect.stringContaining("tool-step limit"),
      },
    });
    expect(insertedMessage.modelMessage.content).toContain("Avoid repeating completed work");
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_continue",
      workspaceId: "wks_123",
    });
  });

  it("rejects ordinary failed sessions", async () => {
    const { db } = dbForContinue({
      ...interruptedSession,
      status: "failed",
      lastError: "Gateway down",
    });
    getDbMock.mockReturnValue(db);

    await expect(continueInterruptedSession("ses_123")).resolves.toEqual({
      ok: false,
      error: "This session is not interrupted.",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("rejects tool-step-limit sessions with an active lease", async () => {
    const { db } = dbForContinue({
      ...interruptedSession,
      status: "failed",
      lastError: TOOL_STEP_LIMIT_EXCEEDED_MESSAGE,
      runLeaseId: "run_active",
    });
    getDbMock.mockReturnValue(db);

    await expect(continueInterruptedSession("ses_123")).resolves.toEqual({
      ok: false,
      error: "This session is still running. Try again shortly.",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });
});

describe("resolveToolApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("waits for the approval resume dispatch after deciding the row", async () => {
    let finishResume!: () => void;
    triggerAgentApprovalResumeMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishResume = resolve;
      }),
    );

    const sessionLimit = vi.fn().mockResolvedValue([{ id: "ses_123" }]);
    const sessionWhere = vi.fn(() => ({ limit: sessionLimit }));
    const sessionFrom = vi.fn(() => ({ where: sessionWhere }));
    const select = vi.fn(() => ({ from: sessionFrom }));
    const returning = vi.fn().mockResolvedValue([{ id: 7 }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));
    getDbMock.mockReturnValue({ select, update } as never);

    let settled = false;
    const resultPromise = resolveToolApproval({
      sessionId: "ses_123",
      toolCallId: "call_123",
      decision: "denied",
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(triggerAgentApprovalResumeMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      toolCallId: "call_123",
      workspaceId: "wks_123",
    });
    expect(settled).toBe(false);

    finishResume();

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(settled).toBe(true);
  });

  it("does not dispatch resume when the approval row was already decided", async () => {
    const sessionLimit = vi.fn().mockResolvedValue([{ id: "ses_123" }]);
    const sessionWhere = vi.fn(() => ({ limit: sessionLimit }));
    const sessionFrom = vi.fn(() => ({ where: sessionWhere }));
    const select = vi.fn(() => ({ from: sessionFrom }));
    const returning = vi.fn().mockResolvedValue([]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));
    getDbMock.mockReturnValue({ select, update } as never);

    const result = await resolveToolApproval({
      sessionId: "ses_123",
      toolCallId: "call_123",
      decision: "denied",
    });

    expect(result).toEqual({
      ok: false,
      error: "This request is no longer awaiting approval.",
    });
    expect(triggerAgentApprovalResumeMock).not.toHaveBeenCalled();
  });
});
