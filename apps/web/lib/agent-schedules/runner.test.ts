import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { agentScheduleRuns } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentAfterSessionCheck } from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";
import { sweepAgentSchedules } from "./runner";

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
  });

  it("does not dispatch duplicate schedule runs", async () => {
    const db = fakeDb({ reserveRows: [] });
    getDbMock.mockReturnValue(db as never);

    const result = await sweepAgentSchedules(new Date("2026-06-01T09:00:00.000Z"));

    expect(result).toMatchObject({ dueRuns: 1, startedRuns: 0, skippedRuns: 1 });
    expect(db.batch).not.toHaveBeenCalled();
    expect(triggerAgentMessageRunMock).not.toHaveBeenCalled();
  });
});

function fakeDb({ reserveRows }: { reserveRows: Array<{ id: number }> }) {
  const db = {
    insertedScheduleRun: null as unknown,
    batch: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn().mockResolvedValue([
          {
            agent: {
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
                    enabled: true,
                  },
                ],
              },
            },
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
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(reserveRows),
            })),
          };
        }
        return { table, value };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({})),
      })),
    })),
  };

  return db;
}
