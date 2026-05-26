import { newAgentSessionId, newAgentSessionMessageId } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import {
  dispatchAgentAfterSessionCheck,
  dispatchAgentSessionStarted,
} from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";
import type { AgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import { getCurrentWorkspace } from "@/lib/auth";
import {
  createAgentSession,
  createAgentSessionFromPrompt,
  submitAgentSessionMessage,
} from "./actions";

vi.mock("@opencompany/agent-runtime", () => ({
  newAgentSessionId: vi.fn(),
  newAgentSessionMessageId: vi.fn(),
}));

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
  getCurrentWorkspace: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/data", () => ({
  loadAgentSessionDetailForWorkspace: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/events", () => ({
  dispatchAgentAfterSessionCheck: vi.fn().mockResolvedValue(undefined),
  dispatchAgentSessionStarted: vi.fn().mockResolvedValue(undefined),
  dispatchAgentSessionAbortRequested: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/message-runner", () => ({
  triggerAgentMessageRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/runner", () => ({
  callRunner: vi.fn(),
  getRunnerPublicUrl: vi.fn().mockReturnValue(null),
}));

const getCurrentWorkspaceMock = vi.mocked(getCurrentWorkspace);
const hasPositiveWorkspaceBalanceMock = vi.mocked(hasPositiveWorkspaceBalance);
const getDbMock = vi.mocked(getDb);
const newAgentSessionIdMock = vi.mocked(newAgentSessionId);
const newAgentSessionMessageIdMock = vi.mocked(newAgentSessionMessageId);
const loadAgentSessionDetailForWorkspaceMock = vi.mocked(loadAgentSessionDetailForWorkspace);
const dispatchAgentAfterSessionCheckMock = vi.mocked(dispatchAgentAfterSessionCheck);
const dispatchAgentSessionStartedMock = vi.mocked(dispatchAgentSessionStarted);
const triggerAgentMessageRunMock = vi.mocked(triggerAgentMessageRun);
const captureServerEventMock = vi.mocked(captureServerEvent);

function fakeAgent() {
  return {
    id: "agt_123",
    name: "Leo",
    path: "agents/leo.agent",
    workspaceId: "wks_123",
    config: { model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" } },
  };
}

function fakeDetail(): AgentSessionDetailPayload {
  return {
    session: {
      id: "ses_123",
      agentId: "agt_123",
      agentName: "Leo",
      agentPath: "agents/leo.agent",
      title: "Untitled",
      status: "created",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      e2bSandboxId: null,
      workdir: "/workspace",
      runLeaseId: null,
      abortRequestedAt: null,
      lastError: null,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z",
    },
    messages: [],
    events: [],
    usage: {
      inputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      outputTextTokens: 0,
      outputReasoningTokens: 0,
      totalTokens: 0,
    },
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: {
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
    },
    runnerUrl: null,
  };
}

function dbWithAgent(agent: ReturnType<typeof fakeAgent> | null) {
  const limit = vi.fn().mockResolvedValue(agent ? [agent] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  const batch = vi.fn().mockResolvedValue(undefined);
  return { select, insert, batch } as never;
}

describe("createAgentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentWorkspaceMock.mockResolvedValue({
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

  it("returns the freshly loaded session detail and sidebar projection on success", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));
    const detail = fakeDetail();
    loadAgentSessionDetailForWorkspaceMock.mockResolvedValue(detail);

    const result = await createAgentSession("agt_123");

    expect(result).toEqual({
      ok: true,
      detail,
      session: {
        id: detail.session.id,
        title: detail.session.title,
        status: detail.session.status,
        modelName: detail.session.modelName,
        lastError: detail.session.lastError,
        createdAt: detail.session.createdAt,
        updatedAt: detail.session.updatedAt,
      },
    });
    expect(loadAgentSessionDetailForWorkspaceMock).toHaveBeenCalledWith(
      "ses_123",
      "usr_123",
      "wks_123",
    );
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

  it("returns a typed error when the created session cannot be loaded", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));
    loadAgentSessionDetailForWorkspaceMock.mockResolvedValue(null);

    const result = await createAgentSession("agt_123");

    expect(result).toEqual({
      ok: false,
      error: "Session was created but could not be loaded.",
    });
    expect(dispatchAgentSessionStartedMock).toHaveBeenCalledWith({
      sessionId: "ses_123",
      workspaceId: "wks_123",
    });
  });
});

describe("createAgentSessionFromPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentWorkspaceMock.mockResolvedValue({
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

  it("returns the freshly loaded session detail and triggers the runner", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()));
    const detail = fakeDetail();
    loadAgentSessionDetailForWorkspaceMock.mockResolvedValue(detail);

    const result = await createAgentSessionFromPrompt("agt_123", "Ship it");

    expect(result).toMatchObject({
      ok: true,
      detail,
      session: { id: detail.session.id, status: detail.session.status },
    });
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
      is_initial_message: true,
      message_length: "Ship it".length,
    });
  });
});

describe("submitAgentSessionMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(true);
    newAgentSessionMessageIdMock.mockReturnValue("msg_456");
  });

  it("captures a message-sent event when a user submits a follow-up message", async () => {
    const limit = vi.fn().mockResolvedValue([{ id: "ses_123", agentId: "agt_123" }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values }));
    const batch = vi.fn().mockResolvedValue(undefined);
    getDbMock.mockReturnValue({ select, insert, batch } as never);

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
      message_id: "msg_456",
      is_initial_message: false,
      message_length: "Follow up".length,
    });
  });
});
