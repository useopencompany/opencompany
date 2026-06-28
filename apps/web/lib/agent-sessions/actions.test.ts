import { newAgentSessionId, newAgentSessionMessageId } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendSessionStreamEvent } from "@/lib/agent-sessions/durable-streams";
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
import { ensureWorkspaceRunAllowance } from "@/lib/billing/run-allowance";
import {
  continueInterruptedSession,
  createAgentSession,
  createAgentSessionFromPrompt,
  createPersonalOnboardingSession,
  resolveToolApproval,
  setAgentSessionCodexSettings,
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

vi.mock("@/lib/billing/run-allowance", () => ({
  ensureWorkspaceRunAllowance: vi.fn(),
  isSpendLimitReason: (reason: string) =>
    reason === "daily_limit_reached" || reason === "weekly_limit_reached",
  // Keep the real wording so error-message assertions stay meaningful.
  runAllowanceErrorMessage: (reason: string, action: "start" | "continue") => {
    if (reason === "daily_limit_reached") {
      return action === "start"
        ? "Daily spending limit reached. Raise the limit in billing settings or wait until it resets to start a session."
        : "Daily spending limit reached. Raise the limit in billing settings or wait until it resets to continue this session.";
    }
    if (reason === "weekly_limit_reached") {
      return action === "start"
        ? "Weekly spending limit reached. Raise the limit in billing settings to start a session."
        : "Weekly spending limit reached. Raise the limit in billing settings to continue this session.";
    }
    return action === "start"
      ? "Add workspace credits to start a session."
      : "Add workspace credits to continue this session.";
  },
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
const ensureWorkspaceRunAllowanceMock = vi.mocked(ensureWorkspaceRunAllowance);

// Builds an ensureWorkspaceRunAllowance result. `true` => allowed; otherwise a
// blocked outcome with the given reason (defaults to an empty balance).
function allowanceResult(
  allowed: boolean,
  reason: "no_balance" | "weekly_limit_reached" | "daily_limit_reached" = "no_balance",
) {
  const base = {
    balanceUsdMicros: allowed ? 1_000_000 : 0,
    weeklySpendUsdMicros: 0,
    weeklySpendLimitUsdMicros: null,
    spendLimitEnabled: false,
    weekStartsAt: new Date(0),
    dailySpendUsdMicros: 0,
    dailySpendLimitUsdMicros: null,
    dailySpendLimitEnabled: false,
    dayStartsAt: new Date(0),
  };
  return allowed
    ? ({ allowed: true, allowance: { allowed: true, reason: null, ...base } } as const)
    : ({
        allowed: false,
        reason,
        allowance: { allowed: false, reason, ...base },
      } as const);
}
const getDbMock = vi.mocked(getDb);
const newAgentSessionIdMock = vi.mocked(newAgentSessionId);
const newAgentSessionMessageIdMock = vi.mocked(newAgentSessionMessageId);
const dispatchAgentAfterSessionCheckMock = vi.mocked(dispatchAgentAfterSessionCheck);
const dispatchAgentSessionStartedMock = vi.mocked(dispatchAgentSessionStarted);
const triggerAgentApprovalResumeMock = vi.mocked(triggerAgentApprovalResume);
const triggerAgentMessageRunMock = vi.mocked(triggerAgentMessageRun);
const captureServerEventMock = vi.mocked(captureServerEvent);
const appendSessionStreamEventMock = vi.mocked(appendSessionStreamEvent);

function fakeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agt_123",
    name: "Leo",
    path: "agents/leo/leo.agent",
    workspaceId: "wks_123",
    config: {
      schemaVersion: "agent.v1",
      engine: "opencompany",
      title: "Leo",
      instructions: "Help the user.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    },
    ...overrides,
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
    engine: "opencompany",
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
  const updateWhere = vi.fn();
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  // The prompt path combines session/status/message/message.created into one batch. The personal
  // onboarding path writes the session first, then the visible first message in a second batch.
  let twoQueryBatchCount = 0;
  const batch = vi.fn(async (queries: unknown[]) => {
    const engine = agent?.config.engine === "codex" ? "codex" : "opencompany";
    const status = engine === "codex" ? "ready" : "created";
    if (queries.length === 4) {
      return [
        [fakeSessionRow({ engine, status })],
        [statusEventRow],
        [fakeMessageRow()],
        [{ id: 2, createdAt: CREATED_AT }],
      ];
    }

    twoQueryBatchCount += 1;
    return twoQueryBatchCount === 1
      ? [[fakeSessionRow({ engine, status })], [statusEventRow]]
      : [[fakeMessageRow()], [{ id: 2, createdAt: CREATED_AT }]];
  });
  return { select, insert, update, batch } as never;
}

describe("createAgentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(true));
    newAgentSessionIdMock.mockReturnValue("ses_123");
    newAgentSessionMessageIdMock.mockReturnValue("msg_123");
  });

  it("returns a billing redirect when the workspace has no credit", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));

    const result = await createAgentSession("agt_123");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/company/settings?billing=insufficient",
      reason: "no_balance",
    });
    expect(dispatchAgentSessionStartedMock).not.toHaveBeenCalled();
  });

  it("returns a personal billing redirect for personal-surface session starts", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));

    const result = await createAgentSession("agt_123", { surface: "personal" });

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/personal/settings?billing=insufficient",
      reason: "no_balance",
    });
    expect(dispatchAgentSessionStartedMock).not.toHaveBeenCalled();
  });

  it("routes a daily-limit block to the limit surface, not the out-of-credits one", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(
      allowanceResult(false, "daily_limit_reached"),
    );

    const result = await createAgentSession("agt_123");

    expect(result).toEqual({
      ok: false,
      error:
        "Daily spending limit reached. Raise the limit in billing settings or wait until it resets to start a session.",
      redirectTo: "/company/settings?billing=limit",
      reason: "daily_limit_reached",
    });
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
      engine: "opencompany",
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
      source: "user",
      engine: "opencompany",
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
      engine: "opencompany",
      source: "agent",
    });
  });

  it("creates empty Codex sessions ready for messaging without native sandbox startup", async () => {
    getDbMock.mockReturnValue(
      dbWithAgent(
        fakeAgent({
          config: {
            ...fakeAgent().config,
            engine: "codex",
          },
        }),
      ),
    );

    const result = await createAgentSession("agt_123");

    if (!result.ok) throw new Error("expected ok result");
    expect(result.detail.session).toMatchObject({
      id: "ses_123",
      engine: "codex",
      status: "ready",
    });
    expect(dispatchAgentSessionStartedMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).toHaveBeenCalledWith("session_started", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      engine: "codex",
      source: "agent",
    });
  });
});

describe("createPersonalOnboardingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(true));
  });

  it("skips the onboarding gate — the caller has not completed onboarding yet", async () => {
    // Regression: without skipOnboarding, currentWorkspace() redirects the submit straight back
    // to /onboarding (the survey row that marks completion is only written inside this
    // action), trapping the user in an onboarding loop.
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));

    const result = await createPersonalOnboardingSession(
      "agt_123",
      { name: "Ada", website: "", role: "Founder" },
      "Help me get started",
    );

    expect(currentWorkspaceMock).toHaveBeenCalledWith({ skipOnboarding: true });
    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/company/settings?billing=insufficient",
      reason: "no_balance",
    });
  });

  it("can start the first onboarding session before the workspace has credits", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));
    newAgentSessionIdMock.mockReturnValue("ses_123");
    newAgentSessionMessageIdMock.mockReturnValue("msg_123");

    const result = await createPersonalOnboardingSession(
      "agt_123",
      { name: "Ada", website: "", role: "Founder" },
      "Help me get started",
      { integrations: [], skipBillingCheck: true },
    );

    if (!result.ok) throw new Error("expected ok result");
    expect(ensureWorkspaceRunAllowanceMock).not.toHaveBeenCalled();
    expect(result.session).toMatchObject({ id: "ses_123", status: "created" });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      workspaceId: "wks_123",
      engine: "opencompany",
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
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(true));
    newAgentSessionIdMock.mockReturnValue("ses_123");
    newAgentSessionMessageIdMock.mockReturnValue("msg_123");
  });

  it("rejects empty messages without touching the database", async () => {
    const result = await createAgentSessionFromPrompt("agt_123", "   ");

    expect(result).toEqual({ ok: false, error: "Message is required." });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("returns a billing redirect when the workspace has no credit", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));

    const result = await createAgentSessionFromPrompt("agt_123", "Hello");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/company/settings?billing=insufficient",
      reason: "no_balance",
    });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("returns a personal billing redirect for personal-surface prompt starts", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));

    const result = await createAgentSessionFromPrompt("agt_123", "Hello", undefined, [], {
      surface: "personal",
    });

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/personal/settings?billing=insufficient",
      reason: "no_balance",
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
      engine: "opencompany",
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
      engine: "opencompany",
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
      engine: "opencompany",
      is_initial_message: true,
      message_length: "Ship it".length,
    });
  });

  it("routes Codex initial messages to the Codex turn runner and skips after-session checks", async () => {
    getDbMock.mockReturnValue(
      dbWithAgent(
        fakeAgent({
          config: {
            ...fakeAgent().config,
            engine: "codex",
          },
        }),
      ),
    );

    const result = await createAgentSessionFromPrompt("agt_123", "Ship it with Codex");

    if (!result.ok) throw new Error("expected ok result");
    expect(result.detail.session).toMatchObject({ id: "ses_123", engine: "codex" });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      workspaceId: "wks_123",
      engine: "codex",
    });
    expect(dispatchAgentAfterSessionCheckMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).toHaveBeenCalledWith("session_message_sent", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      message_id: "msg_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      engine: "codex",
      is_initial_message: true,
      message_length: "Ship it with Codex".length,
    });
  });

  it("persists initial Codex reasoning and plan mode on the new session", async () => {
    const valuesCalls: unknown[] = [];
    const returning = vi.fn(() => ({}));
    const values = vi.fn((rows) => {
      valuesCalls.push(rows);
      return { returning };
    });
    const insert = vi.fn(() => ({ values }));
    const codexAgent = fakeAgent({
      config: {
        ...fakeAgent().config,
        engine: "codex",
      },
    });
    const limit = vi.fn().mockResolvedValue([codexAgent]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const batch = vi.fn().mockResolvedValueOnce([
      [
        fakeSessionRow({
          engine: "codex",
          status: "ready",
          codexReasoningEffort: "xhigh",
          codexPlanModeEnabled: true,
        }),
      ],
      [statusEventRow],
      [fakeMessageRow()],
      [{ id: 2, createdAt: CREATED_AT }],
    ]);
    getDbMock.mockReturnValue({ select, insert, batch } as never);

    const result = await createAgentSessionFromPrompt("agt_123", "Plan it", undefined, [], {
      codexReasoningEffort: "xhigh",
      codexPlanModeEnabled: true,
    });

    expect(result.ok).toBe(true);
    expect(valuesCalls[0]).toEqual(
      expect.objectContaining({
        engine: "codex",
        codexReasoningEffort: "xhigh",
        codexPlanModeEnabled: true,
      }),
    );
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      workspaceId: "wks_123",
      engine: "codex",
    });
  });

  it("rejects invalid initial Codex reasoning before starting the runner", async () => {
    getDbMock.mockReturnValue(
      dbWithAgent(
        fakeAgent({
          config: {
            ...fakeAgent().config,
            engine: "codex",
          },
        }),
      ),
    );

    const result = await createAgentSessionFromPrompt("agt_123", "Plan it", undefined, [], {
      codexReasoningEffort: "maximum",
    } as never);

    expect(result).toEqual({ ok: false, error: "Invalid Codex reasoning effort." });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("ignores Codex-only initial options for OpenCompany sessions", async () => {
    const valuesCalls: unknown[] = [];
    const returning = vi.fn(() => ({}));
    const values = vi.fn((rows) => {
      valuesCalls.push(rows);
      return { returning };
    });
    const insert = vi.fn(() => ({ values }));
    const limit = vi.fn().mockResolvedValue([fakeAgent()]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const batch = vi
      .fn()
      .mockResolvedValueOnce([
        [fakeSessionRow()],
        [statusEventRow],
        [fakeMessageRow()],
        [{ id: 2, createdAt: CREATED_AT }],
      ]);
    getDbMock.mockReturnValue({ select, insert, batch } as never);

    const result = await createAgentSessionFromPrompt("agt_123", "Ship it", undefined, [], {
      codexReasoningEffort: "xhigh",
      codexPlanModeEnabled: true,
    });

    expect(result.ok).toBe(true);
    expect(valuesCalls[0]).not.toEqual(
      expect.objectContaining({
        codexReasoningEffort: expect.any(String),
        codexPlanModeEnabled: expect.any(Boolean),
      }),
    );
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      workspaceId: "wks_123",
      engine: "opencompany",
    });
  });

  it("persists a valid image attachment on the first message", async () => {
    // Capture the rows handed to `.values(...)`: the prompt path builds every insert op (incl.
    // the attachment rows) and passes them into db.batch, so the attachment payload shows up as
    // a `values` call we can assert on.
    const valuesCalls: unknown[] = [];
    const returning = vi.fn(() => ({}));
    const values = vi.fn((rows) => {
      valuesCalls.push(rows);
      return { returning };
    });
    const insert = vi.fn(() => ({ values }));
    const limit = vi.fn().mockResolvedValue([fakeAgent()]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const batch = vi
      .fn()
      .mockResolvedValueOnce([
        [fakeSessionRow()],
        [statusEventRow],
        [fakeMessageRow()],
        [{ id: 2, createdAt: CREATED_AT }],
      ]);
    getDbMock.mockReturnValue({ select, insert, batch } as never);

    const result = await createAgentSessionFromPrompt("agt_123", "Look at this", undefined, [
      {
        blobPathname: "workspace/wks_123/pending/att1-x.png",
        blobUrl: "https://blob.example/x.png",
        mediaType: "image/png",
        filename: "x.png",
        sizeBytes: 1024,
      },
    ]);

    expect(result.ok).toBe(true);
    // The attachment row carries the blob pointer + scoped to the new session/message.
    expect(valuesCalls).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blobPathname: "workspace/wks_123/pending/att1-x.png",
          blobUrl: "https://blob.example/x.png",
          kind: "image",
          sessionId: "ses_123",
          messageId: "msg_123",
        }),
      ]),
    );
  });

  it("rejects an attachment that fails validation without creating a session", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));

    const result = await createAgentSessionFromPrompt("agt_123", "hi", undefined, [
      {
        blobPathname: "workspace/wks_123/pending/att2-x.exe",
        blobUrl: "https://blob.example/x.exe",
        mediaType: "application/x-msdownload",
        filename: "x.exe",
        sizeBytes: 10,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("rejects an attachment scoped to another workspace", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));

    const result = await createAgentSessionFromPrompt("agt_123", "hi", undefined, [
      {
        blobPathname: "workspace/wks_OTHER/pending/att3-x.png",
        blobUrl: "https://blob.example/x.png",
        mediaType: "image/png",
        filename: "x.png",
        sizeBytes: 1024,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("rejects attachments for Codex initial messages", async () => {
    getDbMock.mockReturnValue(
      dbWithAgent(
        fakeAgent({
          config: {
            ...fakeAgent().config,
            engine: "codex",
          },
        }),
      ),
    );

    const result = await createAgentSessionFromPrompt("agt_123", "hi", undefined, [
      {
        blobPathname: "workspace/wks_123/pending/att1-x.png",
        blobUrl: "https://blob.example/x.png",
        mediaType: "image/png",
        filename: "x.png",
        sizeBytes: 1024,
      },
    ]);

    expect(result).toEqual({ ok: false, error: "Codex sessions do not support attachments yet." });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
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
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(true));
    newAgentSessionMessageIdMock.mockReturnValue("msg_456");
  });

  it("captures a message-sent event when a user submits a follow-up message", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: "ses_123",
        agentId: "agt_123",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
        engine: "opencompany",
        status: "completed",
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
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
    }));
    getDbMock.mockReturnValue({ select, insert, batch, update } as never);

    const result = await submitAgentSessionMessage("ses_123", " Follow up ");

    expect(result).toEqual({ ok: true, messageId: "msg_456" });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_456",
      workspaceId: "wks_123",
      engine: "opencompany",
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
      engine: "opencompany",
      message_id: "msg_456",
      is_initial_message: false,
      message_length: "Follow up".length,
    });
  });

  it("emits a question.answered(superseded) event when a freeform reply supersedes a pending question", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: "ses_123",
        agentId: "agt_123",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
        engine: "opencompany",
        status: "completed",
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    // The agentSessionEvents insert for the superseded resolution event reads back [resolutionEvent].
    // insertUserMessage builds its own inserts through the same chain but executes them via db.batch,
    // so the shared returning() here is only consumed by the emit under test.
    const resolutionEventRow = {
      id: 7,
      type: "question.answered",
      messageId: "msg_assistant",
      payload: {
        messageId: "msg_assistant",
        toolCallId: "call_q",
        answered: false,
        answers: [],
        resolutionSource: "superseded",
      },
      createdAt: new Date("2026-06-04T10:00:00.000Z"),
    };
    const returning = vi.fn(() => [resolutionEventRow]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const batch = vi
      .fn()
      .mockResolvedValue([
        [{ id: "msg_456" }],
        [{ id: 1, createdAt: new Date("2026-06-04T10:00:00.000Z") }],
      ]);
    // The supersede UPDATE returns the pending question row(s) it cancelled.
    const update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi
            .fn()
            .mockResolvedValue([{ toolCallId: "call_q", messageId: "msg_assistant" }]),
        })),
      })),
    }));
    getDbMock.mockReturnValue({ select, insert, batch, update } as never);

    const result = await submitAgentSessionMessage("ses_123", "Actually, do X instead");

    expect(result).toEqual({ ok: true, messageId: "msg_456" });
    // Persisted: the clearing runtime event the event-derived UI needs to leave "pending". Without
    // it the superseded question card lingers forever and traps the user.
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "question.answered",
        messageId: "msg_assistant",
        payload: expect.objectContaining({
          toolCallId: "call_q",
          answered: false,
          resolutionSource: "superseded",
        }),
      }),
    );
    // Streamed live so the card clears immediately, not only on reload.
    expect(appendSessionStreamEventMock).toHaveBeenCalledWith(
      "ses_123",
      expect.objectContaining({
        type: "question.answered",
        messageId: "msg_assistant",
        payload: expect.objectContaining({
          toolCallId: "call_q",
          resolutionSource: "superseded",
        }),
      }),
    );
  });

  it("routes Codex follow-up messages to the Codex turn runner and skips after-session checks", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: "ses_123",
        agentId: "agt_123",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
        engine: "codex",
        status: "completed",
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const returning = vi.fn(() => ({}));
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const batch = vi
      .fn()
      .mockResolvedValue([
        [{ id: "msg_456" }],
        [{ id: 1, createdAt: new Date("2026-06-04T10:00:00.000Z") }],
      ]);
    const updateSet = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    }));
    const update = vi.fn(() => ({
      set: updateSet,
    }));
    getDbMock.mockReturnValue({ select, insert, batch, update } as never);

    const result = await submitAgentSessionMessage("ses_123", " Follow up ");

    expect(result).toEqual({ ok: true, messageId: "msg_456" });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_456",
      workspaceId: "wks_123",
      engine: "codex",
    });
    expect(dispatchAgentAfterSessionCheckMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).toHaveBeenCalledWith("session_message_sent", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: "agt_123",
      session_id: "ses_123",
      model_provider: "vercel-ai-gateway",
      model_name: "openai/gpt-5.4-mini",
      engine: "codex",
      message_id: "msg_456",
      is_initial_message: false,
      message_length: "Follow up".length,
    });
    expect(updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ codexPlanModeEnabled: true }),
    );
  });

  it("sets one-shot Codex plan mode for a requested follow-up message", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: "ses_123",
        agentId: "agt_123",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
        engine: "codex",
        status: "completed",
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const returning = vi.fn(() => ({}));
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const batch = vi
      .fn()
      .mockResolvedValue([
        [{ id: "msg_456" }],
        [{ id: 1, createdAt: new Date("2026-06-04T10:00:00.000Z") }],
      ]);
    const updateSet = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    }));
    const update = vi.fn(() => ({
      set: updateSet,
    }));
    getDbMock.mockReturnValue({ select, insert, batch, update } as never);

    const result = await submitAgentSessionMessage("ses_123", " Follow up ", [], "steer", {
      codexPlanModeEnabled: true,
    });

    expect(result).toEqual({ ok: true, messageId: "msg_456" });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        codexPlanModeEnabled: true,
        updatedAt: expect.any(Date),
      }),
    );
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_456",
      workspaceId: "wks_123",
      engine: "codex",
    });
  });

  it("rejects attachments for Codex follow-up messages", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: "ses_123",
        agentId: "agt_123",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
        engine: "codex",
        status: "completed",
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    getDbMock.mockReturnValue({ select } as never);

    const result = await submitAgentSessionMessage("ses_123", "Look", [
      {
        blobPathname: "workspace/wks_123/pending/att1-x.png",
        blobUrl: "https://blob.example/x.png",
        mediaType: "image/png",
        filename: "x.png",
        sizeBytes: 1024,
      },
    ]);

    expect(result).toEqual({ ok: false, error: "Codex sessions do not support attachments yet." });
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("reports missing credits before session existence", async () => {
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));
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

describe("setAgentSessionCodexSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("persists reasoning effort without enabling persistent plan mode", async () => {
    const limit = vi.fn().mockResolvedValue([{ id: "ses_123", engine: "codex" }]);
    const selectWhere = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));
    const returning = vi.fn().mockResolvedValue([{ id: "ses_123" }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    getDbMock.mockReturnValue({ select, update } as never);

    const result = await setAgentSessionCodexSettings("ses_123", {
      reasoningEffort: "high",
      planModeEnabled: true,
    } as never);

    expect(result).toEqual({ ok: true });
    expect(updateSet).toHaveBeenCalledWith({
      codexReasoningEffort: "high",
      updatedAt: expect.any(Date),
    });
  });
});

describe("continueInterruptedSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(true));
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
    engine: "opencompany",
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
    ensureWorkspaceRunAllowanceMock.mockResolvedValue(allowanceResult(false));
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
      engine: "opencompany",
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
      engine: "opencompany",
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
