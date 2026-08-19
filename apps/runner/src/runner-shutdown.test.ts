import { describe, expect, it, vi } from "vitest";
import { drainRunnerTasks } from "./runner-shutdown";

describe("drainRunnerTasks", () => {
  it("lets active work drain without aborting it before the deadline", async () => {
    const stop = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBe(false);
    });

    const result = await drainRunnerTasks({
      tasks: [{ name: "worker", activeCount: () => 1, stop }],
      drainMs: 100,
      postAbortWaitMs: 100,
    });

    expect(result).toEqual({
      activeAtStart: 1,
      interruptedAtDeadline: 0,
      deadlineExceeded: false,
      unfinishedTasks: [],
    });
  });

  it("aborts every unfinished task and reports active work at the deadline", async () => {
    const onDeadline = vi.fn();
    const stop = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const result = await drainRunnerTasks({
      tasks: [{ name: "worker", activeCount: () => 2, stop }],
      drainMs: 1,
      postAbortWaitMs: 100,
      onDeadline,
    });

    expect(onDeadline).toHaveBeenCalledWith({
      activeAtStart: 2,
      interruptedAtDeadline: 2,
      deadlineExceeded: true,
    });
    expect(result).toEqual({
      activeAtStart: 2,
      interruptedAtDeadline: 2,
      deadlineExceeded: true,
      unfinishedTasks: [],
    });
  });
});
