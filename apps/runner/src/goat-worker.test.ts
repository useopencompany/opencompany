import { goatTasks } from "@opencompany/db/goat-schema";
import { describe, expect, it, vi } from "vitest";
import { claimNextGoatTask, type GoatTaskStore } from "./goat-worker";

type GoatTask = typeof goatTasks.$inferSelect;

describe("claimNextGoatTask", () => {
  it("claims through the store with a fresh lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const store: GoatTaskStore = {
        claimNext: vi.fn(),
        heartbeat: vi.fn(),
      };
      const claimedTask = task({ leaseId: "lease_claimed" });
      vi.mocked(store.claimNext).mockResolvedValueOnce(claimedTask);

      await expect(
        claimNextGoatTask({
          leaseOwner: "runner_1",
          store,
          leaseTtlMs: 60_000,
        }),
      ).resolves.toBe(claimedTask);

      expect(store.claimNext).toHaveBeenCalledWith({
        leaseId: expect.stringMatching(/^goat_task_/),
        leaseOwner: "runner_1",
        now: new Date("2026-01-01T00:00:00.000Z"),
        leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function task(overrides: Partial<GoatTask> = {}): GoatTask {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    userWorkosId: "user_1",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    scheduleId: null,
    scheduledFor: null,
    engine: "opencompany",
    status: "running",
    result: null,
    error: null,
    attempts: 1,
    nextRunAt: new Date("2026-01-01T00:00:00.000Z"),
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
