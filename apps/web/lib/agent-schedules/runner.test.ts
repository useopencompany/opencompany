import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { agentScheduleRuns } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentAfterSessionCheck } from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";
import { runScheduledAgent, sweepAgentSchedules } from "./runner";

vi.mock("@opencompany/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/agent-runtime")>();
  return {
    ...actual,
    newAgentSessionId: vi.fn(() => "ses_schedule"),
    newAgentSessionMessageId: vi.fn(() => "msg_schedule"),
  };
});

vi.mock("@opencompany/billing", () => ({
  hasPositiveWorkspaceBalance: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/events", () => ({
  dispatchAgentAfterSessionCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-sessions/message-runner", () => ({
  triggerAgentMessageRun: vi.fn().mockResolvedValue(undefined),
}));

const getDbMock = vi.mocked(getDb);
const hasPositiveWorkspaceBalanceMock = vi.mocked(hasPositiveWorkspaceBalance);
const triggerAgentMessageRunMock = vi.mocked(triggerAgentMessageRun);
const dispatchAgentAfterSessionCheckMock = vi.mocked(dispatchAgentAfterSessionCheck);

describe("sweepAgentSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(true);
  });

  it("creates a visible session and dispatches the runner for a due schedule", async () => {
    const db = fakeDb({ reserveRows: [{ id: 1 }] });
    getDbMock.mockReturnValue(db as never);

    const result = await sweepAgentSchedules(new Date("2026-06-01T09:00:10.000Z"));

    expect(result).toMatchObject({ checkedAgents: 1, dueRuns: 1, startedRuns: 1 });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_schedule",
      messageId: "msg_schedule",
      workspaceId: "wks_123",
    });
    expect(dispatchAgentAfterSessionCheckMock).toHaveBeenCalledWith({
      sessionId: "ses_schedule",
      messageId: "msg_schedule",
      workspaceId: "wks_123",
    });
    expect(db.insertedScheduleRun).toMatchObject({
      agentId: "agt_123",
      triggerId: "weekday-brief",
      scheduledFor: new Date("2026-06-01T09:00:00.000Z"),
    });
    expect(db.insertedScheduleRun).toMatchObject({
      reservationToken: expect.any(String),
      pendingExpiresAt: expect.any(Date),
    });
  });

  it("creates a visible session and schedule run for a manual scheduledFor time", async () => {
    const db = fakeDb({ reserveRows: [{ id: 1, reservationToken: "claim_123" }] });
    getDbMock.mockReturnValue(db as never);
    const scheduledFor = new Date("2026-06-01T12:34:56.789Z");

    const result = await runScheduledAgent({
      agent: fakeAgent(),
      trigger: fakeScheduleTrigger(),
      scheduledFor,
      userId: "usr_clicked",
    });

    expect(result).toMatchObject({ status: "started", sessionId: "ses_schedule" });
    expect(db.insertedScheduleRun).toMatchObject({
      agentId: "agt_123",
      triggerId: "weekday-brief",
      scheduledFor,
    });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.batch.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          id: "ses_schedule",
          userId: "usr_clicked",
          title: "Scheduled: Review open priorities.",
        }),
      }),
    );
    expect(db.batch.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          sessionId: "ses_schedule",
          type: "session.scheduled",
          payload: expect.objectContaining({
            triggerId: "weekday-brief",
            scheduledFor: scheduledFor.toISOString(),
          }),
        }),
      }),
    );
    expect(triggerAgentMessageRunMock).toHaveBeenCalledWith({
      sessionId: "ses_schedule",
      messageId: "msg_schedule",
      workspaceId: "wks_123",
    });
  });

  it("does not dispatch duplicate schedule runs", async () => {
    const db = fakeDb({ reserveRows: [] });
    getDbMock.mockReturnValue(db as never);

    const result = await sweepAgentSchedules(new Date("2026-06-01T09:00:00.000Z"));

    expect(result).toMatchObject({ dueRuns: 1, startedRuns: 0, skippedRuns: 1 });
    expect(db.batch).not.toHaveBeenCalled();
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });

  it("marks a reserved run failed when the workspace has no credits", async () => {
    const db = fakeDb({ reserveRows: [{ id: 1, reservationToken: "claim_123" }] });
    getDbMock.mockReturnValue(db as never);
    hasPositiveWorkspaceBalanceMock.mockResolvedValue(false);

    const result = await sweepAgentSchedules(new Date("2026-06-01T09:00:00.000Z"));

    expect(result).toMatchObject({ dueRuns: 1, startedRuns: 0, failedRuns: 1 });
    expect(db.batch).not.toHaveBeenCalled();
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
    expect(db.scheduleRunUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Workspace has no credits.",
        reservationToken: null,
        pendingExpiresAt: null,
      }),
    );
  });

  it("keeps a started run started when follow-up dispatch fails", async () => {
    const db = fakeDb({ reserveRows: [{ id: 1, reservationToken: "claim_123" }] });
    getDbMock.mockReturnValue(db as never);
    dispatchAgentAfterSessionCheckMock.mockRejectedValueOnce(new Error("follow-up failed"));

    const result = await sweepAgentSchedules(new Date("2026-06-01T09:00:00.000Z"));

    expect(result).toMatchObject({ dueRuns: 1, startedRuns: 1, failedRuns: 0 });
    expect(triggerAgentMessageRunMock).toHaveBeenCalledOnce();
    expect(db.scheduleRunUpdates).toContainEqual(
      expect.objectContaining({
        status: "started",
        sessionId: "ses_schedule",
        reservationToken: null,
        pendingExpiresAt: null,
      }),
    );
    expect(db.scheduleRunUpdates).not.toContainEqual(expect.objectContaining({ status: "failed" }));
  });
});

function fakeScheduleTrigger() {
  return {
    id: "weekday-brief",
    type: "agent.schedule" as const,
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    prompt: "Review open priorities.",
    enabled: true,
  };
}

function fakeAgent() {
  const now = new Date("2026-06-01T00:00:00.000Z");
  return {
    id: "agt_123",
    workspaceId: "wks_123",
    path: "agents/briefing/briefing.agent",
    name: "Briefing",
    body: "Prepare updates.",
    commitSha: null,
    contentHash: "hash_123",
    version: 1,
    githubBlobSha: null,
    githubCommitSha: null,
    githubSyncedHash: null,
    githubSyncedAt: null,
    githubSyncStatus: "synced",
    githubSyncError: null,
    content: { type: "doc", content: [] },
    config: {
      schemaVersion: "agent.v1" as const,
      title: "Briefing",
      instructions: "Prepare updates.",
      model: { provider: "vercel-ai-gateway" as const, name: "openai/gpt-5.4-mini" as const },
      tools: [],
      brain: [],
      agents: [],
      integrations: { github: { repositories: [] } },
      triggers: [fakeScheduleTrigger()],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function fakeDb({
  reserveRows,
}: {
  reserveRows: Array<{ id: number; reservationToken?: string | null }>;
}) {
  const db = {
    insertedScheduleRun: null as unknown,
    scheduleRunUpdates: [] as unknown[],
    batch: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn().mockResolvedValue([
          {
            agent: fakeAgent(),
            workspace: {
              id: "wks_123",
              createdByUserId: "usr_123",
            },
          },
        ]),
      })),
    })),
    insert: vi.fn((table) => ({
      values: vi.fn((value) => {
        if (table === agentScheduleRuns) {
          db.insertedScheduleRun = value;
          return {
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(
                reserveRows.map((row) => ({
                  ...row,
                  reservationToken: row.reservationToken ?? value.reservationToken,
                })),
              ),
            })),
          };
        }
        return { table, value };
      }),
    })),
    update: vi.fn((table) => ({
      set: vi.fn((value) => {
        if (table === agentScheduleRuns) {
          db.scheduleRunUpdates.push(value);
        }
        return {
          where: vi.fn(() => ({})),
        };
      }),
    })),
  };

  return db;
}
