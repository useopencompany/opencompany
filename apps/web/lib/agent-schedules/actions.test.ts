import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import type { AgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import { currentWorkspace } from "@/lib/auth";
import { runAgentScheduleNow } from "./actions";
import { runScheduledAgent } from "./runner";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/data", () => ({
  loadAgentSessionDetailForWorkspace: vi.fn(),
}));

vi.mock("./runner", () => ({
  runScheduledAgent: vi.fn(),
}));

const currentWorkspaceMock = vi.mocked(currentWorkspace);
const getDbMock = vi.mocked(getDb);
const runScheduledAgentMock = vi.mocked(runScheduledAgent);
const loadAgentSessionDetailForWorkspaceMock = vi.mocked(loadAgentSessionDetailForWorkspace);

describe("runAgentScheduleNow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("runs a saved schedule and returns the created session", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()) as never);
    runScheduledAgentMock.mockResolvedValue({ status: "started", sessionId: "ses_schedule" });
    const detail = fakeDetail();
    loadAgentSessionDetailForWorkspaceMock.mockResolvedValue(detail);

    const result = await runAgentScheduleNow("agt_123", "weekday-brief");

    expect(result).toMatchObject({
      ok: true,
      detail,
      session: { id: "ses_schedule", status: "created" },
    });
    expect(runScheduledAgentMock).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: "agt_123", workspaceId: "wks_123" }),
      trigger: expect.objectContaining({ id: "weekday-brief", prompt: "Review open priorities." }),
      scheduledFor: expect.any(Date),
      userId: "usr_123",
    });
    expect(loadAgentSessionDetailForWorkspaceMock).toHaveBeenCalledWith(
      "ses_schedule",
      "usr_123",
      "wks_123",
    );
  });

  it("returns an error when the schedule trigger is not saved on the agent", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()) as never);

    const result = await runAgentScheduleNow("agt_123", "draft-trigger");

    expect(result).toEqual({ ok: false, error: "Schedule not found." });
    expect(runScheduledAgentMock).not.toHaveBeenCalled();
  });

  it("returns the billing redirect when the runner reports insufficient credits", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()) as never);
    runScheduledAgentMock.mockResolvedValue({
      status: "failed",
      reason: "insufficient_credits",
    });

    const result = await runAgentScheduleNow("agt_123", "weekday-brief");

    expect(result).toEqual({
      ok: false,
      error: "Add workspace credits to run this schedule.",
      redirectTo: "/settings?billing=insufficient",
    });
  });
});

function dbWithAgent(agent: ReturnType<typeof fakeAgent> | null) {
  const limit = vi.fn().mockResolvedValue(agent ? [agent] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function fakeAgent() {
  return {
    id: "agt_123",
    workspaceId: "wks_123",
    name: "Briefing",
    config: {
      schemaVersion: "agent.v1",
      title: "Briefing",
      instructions: "Prepare updates.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      agents: [],
      integrations: { github: { repositories: [] } },
      triggers: [
        {
          id: "weekday-brief",
          type: "agent.schedule",
          cron: "0 9 * * 1-5",
          timezone: "UTC",
          prompt: "Review open priorities.",
          enabled: false,
        },
      ],
    },
  };
}

function fakeDetail(): AgentSessionDetailPayload {
  return {
    session: {
      id: "ses_schedule",
      agentId: "agt_123",
      agentName: "Briefing",
      agentPath: "agents/briefing/briefing.agent",
      title: "Scheduled: Review open priorities.",
      status: "created",
      source: "user",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      parentSessionId: null,
      parentMessageId: null,
      parentToolCallId: null,
      e2bSandboxId: null,
      workdir: "/workspace",
      runLeaseId: null,
      abortRequestedAt: null,
      lastError: null,
      createdAt: "2026-06-01T12:34:56.789Z",
      updatedAt: "2026-06-01T12:34:56.789Z",
    },
    related: { parent: null, children: [] },
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
