import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import type { AgentSessionDetailPayload } from "@/lib/agent-sessions/payload";
import { updateAgent } from "@/lib/agents/actions";
import { currentWorkspace } from "@/lib/auth";
import { runAgentScheduleNow, updateWorkspaceAgentSchedules } from "./actions";
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

vi.mock("@/lib/agents/actions", () => ({
  updateAgent: vi.fn(),
}));

vi.mock("./runner", () => ({
  runScheduledAgent: vi.fn(),
}));

const currentWorkspaceMock = vi.mocked(currentWorkspace);
const getDbMock = vi.mocked(getDb);
const runScheduledAgentMock = vi.mocked(runScheduledAgent);
const loadAgentSessionDetailForWorkspaceMock = vi.mocked(loadAgentSessionDetailForWorkspace);
const updateAgentMock = vi.mocked(updateAgent);

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
      redirectTo: "/company/settings?billing=insufficient",
    });
  });
});

describe("updateWorkspaceAgentSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    updateAgentMock.mockResolvedValue({ agent: { id: "agt_123" } } as never);
  });

  it("rejects personal/user-scoped agents by requiring a company agent row", async () => {
    getDbMock.mockReturnValue(dbWithAgent(null) as never);

    const result = await updateWorkspaceAgentSchedules("agt_personal", [validSchedule()]);

    expect(result).toEqual({ ok: false, error: "Agent not found." });
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  it("rejects agents outside the current workspace", async () => {
    getDbMock.mockReturnValue(dbWithAgent(null) as never);

    const result = await updateWorkspaceAgentSchedules("agt_other_workspace", [validSchedule()]);

    expect(result).toEqual({ ok: false, error: "Agent not found." });
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  it("preserves non-schedule triggers and delegates the merged config through updateAgent", async () => {
    const pullRequestTrigger = {
      id: "repo-pr",
      type: "github.pull_request" as const,
      repository: "repo_123",
      events: ["opened" as const],
      branches: ["main"],
      enabled: true,
    };
    getDbMock.mockReturnValue(
      dbWithAgent(
        fakeAgent({
          triggers: [
            {
              id: "old-brief",
              type: "agent.schedule",
              cron: "0 8 * * *",
              timezone: "UTC",
              prompt: "Old brief.",
              enabled: true,
            },
            pullRequestTrigger,
          ],
        }),
      ) as never,
    );

    const result = await updateWorkspaceAgentSchedules("agt_123", [
      validSchedule({ prompt: "New brief." }),
    ]);

    expect(result).toEqual({ ok: true });
    expect(updateAgentMock).toHaveBeenCalledWith("agt_123", {
      config: {
        triggers: [
          {
            id: "weekday-brief",
            type: "agent.schedule",
            cron: "0 9 * * 1-5",
            timezone: "America/New_York",
            prompt: "New brief.",
            enabled: true,
          },
          pullRequestTrigger,
        ],
      },
    });
  });

  it("returns schedule validation errors without writing", async () => {
    getDbMock.mockReturnValue(dbWithAgent(fakeAgent()) as never);

    const result = await updateWorkspaceAgentSchedules("agt_123", [
      validSchedule({ cron: "13 7 3 2 5" }),
    ]);

    expect(result).toEqual({ ok: false, error: "Routine 1 has an unsupported schedule." });
    expect(updateAgentMock).not.toHaveBeenCalled();
  });
});

function dbWithAgent(agent: ReturnType<typeof fakeAgent> | null) {
  const limit = vi.fn().mockResolvedValue(agent ? [agent] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function fakeAgent(input?: { triggers?: unknown[] }) {
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
      triggers: input?.triggers ?? [
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

function validSchedule(input?: Partial<ReturnType<typeof validScheduleBase>>) {
  return {
    ...validScheduleBase(),
    ...input,
  };
}

function validScheduleBase() {
  return {
    id: "weekday-brief",
    cron: "0 9 * * 1-5",
    timezone: "America/New_York",
    prompt: "Review open priorities.",
    enabled: true,
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
      sandboxCostUsdMicros: 0,
    },
    currentContextTokens: 0,
    latestEventId: 0,
    runnerUrl: null,
  };
}
